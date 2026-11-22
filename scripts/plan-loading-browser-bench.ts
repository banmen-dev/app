// pnpm exec node scripts/plan-loading-browser-bench.ts [--runs 20] [--rounds 2] [--port 9774] [--output ...]
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { createBuilder } from 'vite';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { bootProxy } from './boot-proxy.ts';
import { measurePlanCell, planEntries, verifyPlanOperation, verifyPlanUpdates } from './plan-loading-browser.ts';
import { planBrowserFixtures, planBrowserFixtureSql } from './plan-loading-browser-fixture.ts';
import { planLoadingBrowserPlugin } from './plan-loading-browser-variant.ts';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { fillSeedDates } from './seed-dates.ts';
import { sessionInserts } from './seed.ts';
import { TEST_CREDENTIAL_KEYS } from './test-credential-keys.ts';
import { finishTodayBenchmark, preserveTodayBuild } from './today-loading-support.ts';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (value === undefined || (index >= 0 && (!value || value.startsWith('--'))))
    throw new Error(`${name} の値がありません`);
  return value;
}

const runs = Number(option('--runs', '20'));
const rounds = Number(option('--rounds', '2'));
const port = Number(option('--port', '9774'));
if (
  ![runs, rounds, port].every(Number.isSafeInteger) ||
  runs < 1 ||
  runs > 1000 ||
  rounds < 1 ||
  rounds > 10 ||
  port < 1024 ||
  port > 65532
)
  throw new Error('runs/rounds/port が範囲外です');
const output = path.resolve(option('--output', path.join(tmpdir(), 'plan-loading-browser.json')));
if (existsSync(output)) throw new Error(`出力先が既にあります: ${output}`);
const executablePath = option('--chromium', '') || undefined;
const root = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), 'scrum-guild-plan-'));
const config = path.join(dir, 'wrangler.json');
const origin = `http://127.0.0.1:${port}`;
const version = `plan-loading-browser-${randomUUID()}`;
const fixtureDate = '2026-11-22T00:00:00.000Z';
const env = {
  ...process.env,
  APP_VERSION: version,
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  WRANGLER_LOG_PATH: path.join(dir, 'wrangler.log'),
  WRANGLER_SEND_METRICS: 'false',
};
const proxy = bootProxy(port + 1);
let persist = path.join(dir, 'round-1');
let tracked: ReturnType<typeof trackServer> | undefined;
let browser: Browser | undefined;
let restoreBuild: (() => void) | undefined;
let interrupted = false;
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const stop = () => {
  interrupted = true;
  tracked?.interrupt();
  void browser?.close();
};
for (const signal of signals) process.on(signal, stop);

function command(bin: string, args: string[], cwd = dir): string {
  if (interrupted) throw new Error('計測を中断しました');
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0)
    throw new Error(`${bin} ${args.slice(0, 2).join(' ')}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout.trim();
}

function configure(assets: string) {
  writeFileSync(
    config,
    JSON.stringify({
      name: 'plan-loading-browser-bench',
      main: path.join(root, 'src/server/index.ts'),
      compatibility_date: '2026-10-01',
      send_metrics: false,
      assets: {
        directory: assets,
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api', '/api/*'],
      },
      vars: {
        PUBLIC_ORIGIN: origin,
        APP_VERSION: version,
        OPERATOR_LOGIN_IDS: SEED_OPERATOR_LOGIN_ID,
        CONNECTION_CREDENTIAL_KEYS: TEST_CREDENTIAL_KEYS,
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'plan-loading-browser-bench',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: path.join(root, 'migrations'),
        },
      ],
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'plan-loading-browser-bench' }],
    }),
  );
}

function wrangler(args: string[]) {
  return command('wrangler', [...args, '--config', config, '--local', '--persist-to', persist]);
}

async function stopWorker() {
  await tracked?.stop();
  tracked = undefined;
}

async function startWorker(assets: string) {
  await stopWorker();
  if (interrupted) throw new Error('計測を中断しました');
  configure(assets);
  const child = spawn(
    'wrangler',
    [
      'dev',
      '--config',
      config,
      '--local',
      '--persist-to',
      persist,
      '--port',
      String(port + 1),
      '--inspector-port',
      String(port + 2),
    ],
    { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  const capture = (data: Buffer) => {
    log = (log + data.toString()).slice(-6000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  tracked = trackServer(child, true);
  for (let i = 0; i < 120 && !interrupted && !tracked.stopped; i++) {
    try {
      const result = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (result.ok && isBenchHealth(await result.json(), version)) return;
    } catch {
      // 起動を待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Worker の起動に失敗しました: ${log}`);
}

const samples: Record<string, unknown>[] = [];
const failures: string[] = [];
const metadata: Record<string, unknown> = {
  runs,
  rounds,
  startedAt: new Date().toISOString(),
  browser: samples,
  failures,
  fixture: {
    date: fixtureDate,
    seed: 'seed/data.sql',
    workspaces: planBrowserFixtures,
    role: 'member',
  },
  platform: `${platform()} ${arch()}`,
  cache:
    'fresh context for every direct trial; one context per SPA cell; HTTP cache and data preloading disabled; service workers blocked',
  network: 'loopback with gzip; no simulated delay or throttling',
  viewport: { width: 1280, height: 900 },
};
let failure: unknown;
try {
  metadata.base = command('git', ['rev-parse', 'HEAD'], root);
  metadata.node = process.version;
  metadata.pnpm = command('pnpm', ['--version'], root);
  metadata.wrangler = command('wrangler', ['--version'], root);
  metadata.inputHashes = Object.fromEntries(
    [
      'seed/data.sql',
      'scripts/plan-loading-browser-bench.ts',
      'scripts/plan-loading-browser.ts',
      'scripts/plan-loading-browser-fixture.ts',
      'scripts/loading-fixture.ts',
      'scripts/plan-loading-browser-variant.ts',
    ].map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [`--disk-cache-dir=${path.join(dir, 'browser-cache')}`],
  });
  metadata.chromium = browser.version();
  const build = path.join(root, 'build');
  restoreBuild = preserveTodayBuild(build, path.join(dir, 'original-build'));
  const assets = (variant: 'B' | 'C') => path.join(dir, variant);
  const variants = ['B', 'C'] as const;
  for (const variant of variants) {
    if (interrupted) throw new Error('計測を中断しました');
    console.log(`計測専用ビルド ${variant}`);
    await (await createBuilder({ plugins: [planLoadingBrowserPlugin(variant)] })).buildApp();
    cpSync(build, assets(variant), { recursive: true });
  }
  restoreBuild();
  const fixture = path.join(dir, 'fixture.sql');
  writeFileSync(
    fixture,
    fillSeedDates(readFileSync(path.join(root, 'seed/data.sql'), 'utf8'), new Date(fixtureDate)) +
      sessionInserts([SEED_SESSIONS.member], new Date()) +
      planBrowserFixtureSql(new Date(fixtureDate)),
  );
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', resolve);
  });
  for (let round = 1; round <= rounds; round++) {
    await stopWorker();
    persist = path.join(dir, `round-${round}`);
    configure(assets('B'));
    wrangler(['d1', 'migrations', 'apply', 'DB']);
    wrangler(['d1', 'execute', 'DB', '--file', fixture]);
    const reversed = round % 2 === 0;
    for (const variant of reversed ? [...variants].reverse() : variants) {
      await startWorker(assets(variant));
      for (const fixture of reversed ? [...planBrowserFixtures].reverse() : planBrowserFixtures) {
        for (const entry of reversed ? [...planEntries].reverse() : planEntries) {
          console.log(`ブラウザ ${round}/${rounds} ${variant} ${fixture.key} ${entry}`);
          try {
            await measurePlanCell(
              browser,
              origin,
              fixture,
              entry,
              runs,
              (run, sample) => {
                samples.push({ round, run, variant, entry, fixture: fixture.key, ...sample });
              },
              () => interrupted,
            );
          } catch (error) {
            throw new Error(`巡${round} ${variant} ${fixture.key} ${entry}: ${String(error)}`, { cause: error });
          }
        }
      }
    }
  }
  const planned = planBrowserFixtures.find(({ key }) => key === 'planned')!;
  const closed = planBrowserFixtures.find(({ key }) => key === 'closed')!;
  await startWorker(assets('B'));
  await verifyPlanOperation(browser, origin, planned, 'B');
  await verifyPlanOperation(browser, origin, closed, 'B');
  await startWorker(assets('C'));
  await verifyPlanOperation(browser, origin, planned, 'C');
  await verifyPlanOperation(browser, origin, closed, 'C');
  await verifyPlanUpdates(browser, origin, planned);
  metadata.functionalChecks = true;
} catch (error) {
  failure = error;
  failures.push(String(error));
} finally {
  metadata.finishedAt = new Date().toISOString();
  for (const signal of signals) process.removeListener(signal, stop);
  try {
    await finishTodayBenchmark(
      () => undefined,
      [
        () => browser?.close(),
        () => {
          if (proxy.listening)
            return new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
        },
        stopWorker,
        () => {
          // 復元できなかった場合はバックアップも含めて残す。
          try {
            restoreBuild?.();
          } catch (error) {
            throw new Error(`ビルド復元に失敗しました。バックアップ: ${path.join(dir, 'original-build')}`, {
              cause: error,
            });
          }
          rmSync(dir, { recursive: true, force: true });
        },
      ],
      failure,
    );
  } catch (error) {
    failures.push(String(error));
    failure = error;
  } finally {
    writeFileSync(output, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  }
}
if (failure !== undefined) throw failure;
