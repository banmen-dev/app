import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from '@playwright/test';
import { createBuilder } from 'vite';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { bootProxy } from './boot-proxy.ts';
import { epicEntries, epicId, measureEpic, verifyEpicRefresh, workspacePath } from './epic-loading-browser.ts';
import { epicLoadingPlugin, epicVariants } from './epic-loading-variant.ts';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { fillSeedDates } from './seed-dates.ts';
import { sessionInserts } from './seed.ts';
import { TEST_CREDENTIAL_KEYS } from './test-credential-keys.ts';
import { finishTodayBenchmark, preserveTodayBuild } from './today-loading-support.ts';
import type { EpicSample } from './epic-loading-summary.ts';

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '20' },
    rounds: { type: 'string', default: '2' },
    port: { type: 'string', default: '9860' },
    output: { type: 'string', default: path.join(tmpdir(), 'epic-loading.json') },
  },
});
const runs = Number(args.runs);
const rounds = Number(args.rounds);
const port = Number(args.port);
if (
  !Number.isSafeInteger(runs) ||
  runs < 1 ||
  runs > 1000 ||
  !Number.isSafeInteger(rounds) ||
  rounds < 1 ||
  rounds > 10 ||
  !Number.isSafeInteger(port) ||
  port < 1024 ||
  port > 65533
)
  throw new Error('runs/rounds/port が範囲外です');

const root = process.cwd();
const output = path.resolve(args.output);
const dir = mkdtempSync(path.join(tmpdir(), 'banmen-epic-'));
const origin = `http://127.0.0.1:${port}`;
const config = path.join(dir, 'wrangler.json');
const fixture = path.join(dir, 'seed.sql');
const proxy = bootProxy(port + 1);
const started = new Date();
const version = `epic-loading-${randomUUID()}`;
const env = {
  ...process.env,
  APP_VERSION: version,
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  WRANGLER_LOG_PATH: path.join(dir, 'wrangler.log'),
  WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
};
let worker: ReturnType<typeof trackServer> | undefined;
let browser: Browser | undefined;
let restoreBuild: (() => void) | undefined;
let interrupted = false;
let failure: unknown;
const samples: EpicSample[] = [];
const report: Record<string, unknown> = { startedAt: started.toISOString(), runs, rounds, samples };
function stop() {
  interrupted = true;
  worker?.interrupt();
  void browser?.close();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
function checkRunning() {
  if (interrupted) throw new Error('計測を中断しました');
}
function command(binary: string, args: string[], cwd = root) {
  checkRunning();
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${binary} ${args.slice(0, 2).join(' ')}: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
function configure(assets: string) {
  writeFileSync(
    config,
    JSON.stringify({
      name: 'epic-loading-bench',
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
          database_name: 'epic-loading-bench',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: path.join(root, 'migrations'),
        },
      ],
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'epic-loading-bench' }],
    }),
  );
}
function localOptions(persist: string) {
  return ['--config', config, '--local', '--persist-to', persist];
}
async function serve(assets: string, persist: string) {
  checkRunning();
  await worker?.stop();
  configure(assets);
  const child = spawn(
    'wrangler',
    ['dev', ...localOptions(persist), '--port', String(port + 1), '--inspector-port', String(port + 2)],
    { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  const capture = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-6000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  worker = trackServer(child, true);
  for (let i = 0; i < 120 && !worker.stopped; i++) {
    checkRunning();
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok && isBenchHealth(await res.json(), version)) return;
    } catch {
      // Worker が HTTP を受け付けるまで待つ
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Worker の起動を確認できません: ${log}`);
}
function save() {
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
function restoreOriginalBuild() {
  if (!restoreBuild) return;
  try {
    restoreBuild();
    restoreBuild = undefined;
  } catch (error) {
    throw new Error(`build の復元に失敗しました。バックアップの親ディレクトリ: ${dir}`, { cause: error });
  }
}
try {
  browser = await chromium.launch({ headless: true });
  Object.assign(report, {
    base: command('git', ['rev-parse', 'HEAD']),
    node: process.version,
    pnpm: command('pnpm', ['--version']),
    wrangler: command('wrangler', ['--version']),
    chromium: browser.version(),
    os: `${platform()} ${arch()}`,
    cache: 'HTTP cache disabled by CDP, service workers blocked, target link preload off',
    network: 'loopback, gzip, no throttling or artificial delay',
    viewport: '1280×900, ja-JP, Asia/Tokyo',
    fixture: {
      source: 'seed/data.sql',
      role: 'member',
      workspacePath,
      epicId,
      epics: 1,
      storiesBelowEpic: 1,
      categories: 2,
      repositories: 2,
      dateAnchor: started.toISOString(),
    },
    inputHashes: Object.fromEntries(
      [
        'scripts/epic-loading-browser-bench.ts',
        'scripts/epic-loading-browser.ts',
        'scripts/epic-loading-variant.ts',
        'scripts/epic-loading-summary.ts',
        'seed/data.sql',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(path.join(root, file)))
          .digest('hex'),
      ]),
    ),
  });
  process.env.APP_VERSION = version;
  const build = path.join(root, 'build');
  restoreBuild = preserveTodayBuild(build, path.join(dir, 'original-build'));
  for (const variant of epicVariants) {
    checkRunning();
    console.log(`計測専用ビルド ${variant}`);
    await (await createBuilder({ plugins: [epicLoadingPlugin(variant)] })).buildApp();
    command(process.execPath, ['scripts/write-headers.ts']);
    cpSync(build, path.join(dir, variant), { recursive: true });
  }
  restoreOriginalBuild();
  writeFileSync(
    fixture,
    fillSeedDates(readFileSync(path.join(root, 'seed/data.sql'), 'utf8'), started) +
      sessionInserts(Object.values(SEED_SESSIONS), started),
  );
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', resolve);
  });
  for (let round = 1; round <= rounds; round++) {
    await worker?.stop();
    worker = undefined;
    const persist = path.join(dir, `round-${round}`);
    configure(path.join(dir, 'A'));
    command('wrangler', ['d1', 'migrations', 'apply', 'DB', ...localOptions(persist)], dir);
    command('wrangler', ['d1', 'execute', 'DB', '--file', fixture, ...localOptions(persist)], dir);
    const order = round % 2 ? epicVariants : epicVariants.toReversed();
    for (const variant of order) {
      await serve(path.join(dir, variant), persist);
      for (const entry of epicEntries) {
        console.log(`ブラウザ ${round}/${rounds} ${variant} ${entry}`);
        for (let trial = -2; trial < runs; trial++) {
          checkRunning();
          try {
            const value = await measureEpic(browser, origin, entry, variant);
            if (trial >= 0) samples.push({ ...value, round, variant, entry, trial });
          } catch (error) {
            throw new Error(`巡 ${round}／方式 ${variant}／経路 ${entry}／試行 ${trial}: ${String(error)}`, {
              cause: error,
            });
          }
        }
        save();
      }
    }
    if (round === rounds) {
      await serve(path.join(dir, 'C'), persist);
      await verifyEpicRefresh(browser, origin);
      report.refreshVerified = true;
    }
  }
  report.completedAt = new Date().toISOString();
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await finishTodayBenchmark(
    save,
    [
      () => browser?.close(),
      () => worker?.stop(),
      () =>
        new Promise<void>((resolve) => {
          if (proxy.listening) proxy.close(() => resolve());
          else resolve();
        }),
      restoreOriginalBuild,
      () => {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
      },
      () => {
        if (!restoreBuild) rmSync(dir, { recursive: true, force: true });
      },
    ],
    failure,
  );
}
console.log(`結果 ${output}`);
