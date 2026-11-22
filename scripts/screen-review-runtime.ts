import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium, type Browser } from '@playwright/test';
import { devPorts, devPublicOrigin } from './dev-ports.ts';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { TEST_CREDENTIAL_KEYS } from './test-credential-keys.ts';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export async function serveReference(root: string) {
  const directory = await realpath(resolve(root, 'design'));
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const filename = await realpath(resolve(directory, `.${path}`));
      if (!filename.startsWith(directory + sep) || !MIME_TYPES[extname(filename)]) {
        response.writeHead(404).end();
        return;
      }
      const contents = await readFile(filename);
      response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filename)] }).end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; quiet?: boolean },
): Promise<void> {
  const { quiet, ...spawnOptions } = options;
  const child = spawn(command, args, { ...spawnOptions, stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
  const [code, signal] = await once(child, 'close');
  if (code !== 0) throw new Error(`${command} ${args[0] ?? ''} が失敗しました（${code ?? signal}）`);
}

export async function launchChromium(options: Parameters<typeof runCommand>[2]): Promise<Browser> {
  const executablePath = process.env.SCREEN_REVIEW_CHROMIUM;
  try {
    return await chromium.launch({ executablePath });
  } catch (error) {
    if (executablePath || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
    console.log('撮影用の Chromium を入れます');
    await runCommand('playwright', ['install', 'chromium'], options);
    return chromium.launch();
  }
}

export function localReviewRuntime(
  root: string,
  scratch: string,
  fixedTime: Date,
  version: string,
  signal: AbortSignal,
) {
  const ports = devPorts(process.env, root);
  const origin = devPublicOrigin(ports, false);
  const persist = resolve(scratch, 'd1');
  const envFile = resolve(scratch, 'screen-review.vars');
  const seedFile = resolve(scratch, 'seed.sql');
  const seedArgs = ['--persist-to', persist, '--env-file', envFile];
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: resolve(scratch, 'config'),
    WRANGLER_LOG_PATH: resolve(scratch, 'wrangler.log'),
    WRANGLER_SEND_METRICS: 'false',
  };
  const options = { cwd: root, env, signal };
  const children: ReturnType<typeof trackServer>[] = [];
  const logs = new Map<string, string>();
  let seeded = false;

  function start(name: string, bin: string, args: string[], ipc = false) {
    const child = spawn(bin, args, {
      cwd: root,
      env,
      stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    children.push(trackServer(child, true));
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8').on('data', (chunk: string) => {
        logs.set(name, ((logs.get(name) ?? '') + chunk).slice(-3000));
      });
    }
    return child;
  }

  return {
    origin,
    options,
    async resetSeed() {
      if (seeded) {
        await runCommand('wrangler', ['d1', 'execute', 'DB', '--local', ...seedArgs, '--file', seedFile], {
          ...options,
          quiet: true,
        });
        return;
      }
      await writeFile(envFile, '');
      await runCommand(
        process.execPath,
        ['scripts/db-seed.ts', ...seedArgs, '--save-sql', seedFile, '--now', fixedTime.toISOString()],
        options,
      );
      seeded = true;
    },
    async start() {
      await mkdir(resolve(root, 'build'), { recursive: true });
      await runCommand('svelte-kit', ['sync'], options);
      // Vite と Worker は worktree の開発用ポートを使い、D1 だけ撮影用の使い捨てにする。
      start('wrangler', 'wrangler', [
        'dev',
        '--local',
        '--persist-to',
        persist,
        '--env-file',
        envFile,
        '--ip',
        'localhost',
        '--port',
        String(ports.api),
        '--inspector-port',
        String(ports.inspector),
        '--var',
        `PUBLIC_ORIGIN:${origin}`,
        '--var',
        `APP_VERSION:${version}`,
        '--var',
        `DEV_NOW:${fixedTime.toISOString()}`,
        '--var',
        `CONNECTION_CREDENTIAL_KEYS:${TEST_CREDENTIAL_KEYS}`,
      ]);
      let viteReady = false;
      const vite = start('vite', process.execPath, ['scripts/screen-review-vite.ts'], true);
      vite.on('message', (message) => {
        if (message === 'ready') viteReady = true;
      });
      for (let attempt = 0; attempt < 120; attempt++) {
        signal.throwIfAborted();
        if (children.some((child) => child.stopped)) break;
        if (viteReady) {
          const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })
            .then((response) => response.json())
            .catch(() => null);
          if (isBenchHealth(health, version)) return;
        }
        await setTimeout(250, undefined, { signal });
      }
      const details = [...logs].map(([bin, log]) => `[${bin}] ${log.trim()}`).join('\n');
      throw new Error(
        `撮影用の開発サーバーが起動しません。使用中のポート（${ports.app}、${ports.api}、${ports.inspector}）を確認してください\n${details}`,
      );
    },
    async close() {
      await Promise.all(children.map((child) => child.stop()));
    },
  };
}
