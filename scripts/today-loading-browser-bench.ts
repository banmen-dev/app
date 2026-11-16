// node scripts/today-loading-browser-bench.ts [--runs 20] [--rounds 2] [--port 9750] [--output /tmp/today-loading.json]
// 製品コードは編集せず、使い捨て D1 と計測専用 B/C ビルドを使う。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuilder } from 'vite';
import { chromium, type Browser, type Page, type Request } from '@playwright/test';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { today, firstSteps } from '../src/shared/operations/organization/index.ts';
import { sessionInserts } from './seed.ts';
import { todayTrial } from './today-loading-trial.ts';
import { TEST_CREDENTIAL_KEYS } from './test-credential-keys.ts';
import { finishTodayBenchmark, preserveTodayBuild, TodayBrowserChecks } from './today-loading-support.ts';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { bootProxy } from './boot-proxy.ts';
import { todayCases, todayCaseSlug, todayLoadingFixture, todayFixtureAt } from './today-loading-fixture.ts';
import { todayLoadingPlugin, type TodayVariant } from './today-loading-variant.ts';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} の値がありません`);
  return value;
}
const runs = Number(option('--runs', '20'));
const rounds = Number(option('--rounds', '2'));
const port = Number(option('--port', '9750'));
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
const output = path.resolve(option('--output', path.join(tmpdir(), 'today-loading.json')));
const fixtureAt = todayFixtureAt(option('--fixture-at', new Date().toISOString()));
const root = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), 'scrum-guild-today-'));
const origin = `http://127.0.0.1:${port}`;
const config = path.join(dir, 'wrangler.json');
const version = `today-loading-${randomUUID()}`;
let persist = path.join(dir, 'round-1');
const env = {
  ...process.env,
  APP_VERSION: version,
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  WRANGLER_LOG_PATH: path.join(dir, 'wrangler.log'),
  WRANGLER_SEND_METRICS: 'false',
};
let tracked: ReturnType<typeof trackServer> | undefined;
let browser: Browser | undefined;
const proxy = bootProxy(port + 1);
let restoreBuild: (() => void) | undefined;
let measurementError: unknown;
let interrupted = false;
const stop = () => {
  interrupted = true;
  tracked?.interrupt();
  void browser?.close();
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
function command(bin: string, args: string[], cwd = dir): string {
  if (interrupted) throw new Error('計測を中断しました');
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0)
    throw new Error(`${bin} ${args.slice(0, 2).join(' ')}: ${result.stderr || result.error}`);
  return result.stdout;
}
function configuration(assets: string) {
  writeFileSync(
    config,
    JSON.stringify({
      name: 'today-loading-bench',
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
          database_name: 'today-loading-bench',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: path.join(root, 'migrations'),
        },
      ],
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'today-loading-bench' }],
    }),
  );
}
function wrangler(args: string[]): string {
  return command('wrangler', [...args, '--config', config, '--local', '--persist-to', persist]);
}
async function startServer(assets: string) {
  await tracked?.stop();
  configuration(assets);
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
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  tracked = trackServer(child, true);
  for (let i = 0; ; i++) {
    if (interrupted || tracked.stopped || i >= 120) throw new Error(`起動失敗: ${log}`);
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok && isBenchHealth(await res.json(), version)) return;
    } catch {
      /* 起動を待つ */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
async function read(slug: string, name: 'today' | 'first-steps') {
  const response = await fetch(`${origin}/api/${slug}/${name}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: `${sessionCookieName(origin)}=${SEED_SESSIONS.member.token}`,
    },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  const body: unknown = await response.json();
  const finished = performance.now();
  const schema = name === 'today' ? today.output : firstSteps.output;
  return {
    body,
    finishedAt: finished,
    ms: 0,
    secondary: name === 'first-steps',
    validate: () => {
      if (!response.ok || !schema.safeParse(body).success)
        throw new Error(`${slug}/${name}: HTTP ${response.status} または出力が不正`);
    },
  };
}
type ApiSample = {
  round: number;
  case: number;
  variant: 'A' | TodayVariant;
  reverse: boolean;
  primary: number;
  load: number;
  total: number;
};
type BrowserSample = {
  round: number;
  case: number;
  variant: TodayVariant;
  reverse: boolean;
  entry: string;
  primary: number;
  secondary: number;
  load: number;
  ready: number;
  hasTask: boolean;
  shell: number;
};
const api: ApiSample[] = [];
const samples: BrowserSample[] = [];
const report: Record<string, unknown> = {
  base: command('git', ['rev-parse', 'HEAD'], root).trim(),
  node: process.version,
  pnpm: command('pnpm', ['--version'], root).trim(),
  runs,
  rounds,
  startedAt: new Date().toISOString(),
  cache: 'CDP cache disabled; service workers blocked',
  network: 'loopback, no artificial delay or network throttling',
  fixtureAt: fixtureAt.toISOString(),
  fixture: '5000 tasks, 30 marked; leader pending and admin have no tasks',
  api,
  browser: samples,
};
function save() {
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
const requests = new WeakMap<Page, Set<Request>>();
async function drained(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const until = Date.now() + 30000;
  while (requests.get(page)!.size > 0) {
    if (Date.now() > until) throw new Error('前の試行の通信が完了しません');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function ready(page: Page, hasTask: boolean, started: number) {
  await page.waitForFunction(
    () => performance.getEntriesByName('bench:load').length > 0 && document.querySelector('#p-today') !== null,
  );
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  if (hasTask)
    await page.locator('section[aria-labelledby="p-today"] button.sun').first().click({ trial: true, timeout: 10000 });
  else await page.locator('section[aria-labelledby="p-today"]').waitFor({ state: 'visible' });
  const result = await page.evaluate(() => ({
    ready: performance.now(),
    primary: performance.getEntriesByName('bench:primary').at(-1)!.startTime,
    load: performance.getEntriesByName('bench:load').at(-1)!.startTime,
  }));
  await page.waitForFunction(() => performance.getEntriesByName('bench:secondary').length > 0);
  // 従と組織の枠も完了したことを確かめてから次の試行へ進む。
  await drained(page);
  const rest = await page.evaluate(() => ({
    secondary: performance.getEntriesByName('bench:secondary').at(-1)!.startTime,
    shell: Math.max(
      0,
      ...performance
        .getEntriesByType('resource')
        .filter((entry) =>
          /\/(organization|my-organizations|token-notice|favorite-list|invitation-list)$/.test(
            new URL(entry.name).pathname,
          ),
        )
        .map((entry) => (entry as PerformanceResourceTiming).responseEnd),
    ),
  }));
  return {
    primary: result.primary - started,
    load: result.load - started,
    ready: result.ready - started,
    secondary: rest.secondary - started,
    shell: Math.max(0, rest.shell - started),
  };
}
try {
  // 最初にブラウザを確認する。ブラウザ不在を測定値0に置き換えない。
  browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
  restoreBuild = preserveTodayBuild(path.join(root, 'build'), path.join(dir, 'original-build'));
  for (const reverse of [false, true])
    for (const variant of ['B', 'C'] as const) {
      console.log(`計測専用ビルド: ${variant} ${reverse ? '逆順' : '正順'}`);
      await (await createBuilder({ plugins: [todayLoadingPlugin(variant, reverse)] })).buildApp();
      cpSync(path.join(root, 'build'), path.join(dir, `${variant}-${reverse}`), { recursive: true });
    }
  restoreBuild();
  configuration(path.join(dir, 'B-false'));
  const fixture = path.join(dir, 'fixture.sql');
  writeFileSync(
    fixture,
    readFileSync(path.join(root, 'seed/data.sql'), 'utf8') +
      sessionInserts(Object.values(SEED_SESSIONS), new Date()) +
      todayLoadingFixture(fixtureAt),
  );

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', resolve);
  });
  for (let round = 1; round <= rounds; round++) {
    await tracked?.stop();
    tracked = undefined;
    persist = path.join(dir, `round-${round}`);
    configuration(path.join(dir, 'B-false'));
    wrangler(['d1', 'migrations', 'apply', 'DB']);
    wrangler(['d1', 'execute', 'DB', '--file', fixture]);
    await startServer(path.join(dir, 'B-false'));
    for (const [index, condition] of todayCases.entries()) {
      const slug = todayCaseSlug(index);
      const first = firstSteps.output.parse((await read(slug, 'first-steps')).body);
      const main = today.output.parse((await read(slug, 'today')).body);
      if (condition.pending ? first.role !== condition.role || first.steps.length === 0 : first.steps.length !== 0)
        throw new Error(`${slug}: 手順の条件が不正`);
      const hasTask = condition.role === 'member' || (condition.role === 'leader' && !condition.pending);
      if (main.tasks.length > 0 !== hasTask) throw new Error(`${slug}: タスクの条件が不正`);
      for (const reverse of [false, true])
        for (const variant of (round % 2 ? ['A', 'B', 'C'] : ['C', 'B', 'A']) as ('A' | TodayVariant)[]) {
          console.log(`API ${round}/${rounds} ${slug} ${variant} ${reverse}`);
          for (let run = -2; run < runs; run++) {
            const value = await todayTrial(variant, reverse, (secondary) =>
              read(slug, secondary ? 'first-steps' : 'today'),
            );
            if (run >= 0)
              api.push({
                round,
                case: index,
                variant,
                reverse,
                primary: value.primary,
                load: value.ready,
                total: value.total,
              });
          }
        }
    }
    const combinations = ([false, true] as const).flatMap((reverse) =>
      (['B', 'C'] as const).map((variant) => ({ variant, reverse })),
    );
    if (round % 2 === 0) combinations.reverse();
    for (const { variant, reverse } of combinations) {
      await startServer(path.join(dir, `${variant}-${reverse}`));
      for (const [index, condition] of todayCases.entries()) {
        const slug = todayCaseSlug(index);
        const hasTask = condition.role === 'member' || (condition.role === 'leader' && !condition.pending);
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          serviceWorkers: 'block',
          locale: 'ja-JP',
          timezoneId: 'Asia/Tokyo',
        });
        try {
          await context.addCookies([
            { name: sessionCookieName(origin), value: SEED_SESSIONS.member.token, url: origin },
          ]);
          const page = await context.newPage();
          const active = new Set<Request>();
          requests.set(page, active);
          page.on('request', (request) => active.add(request));
          page.on('requestfinished', (request) => active.delete(request));
          const checks = new TodayBrowserChecks();
          page.on('requestfailed', (request) => {
            active.delete(request);
            checks.requestFailed(new URL(request.url()).pathname, request.failure()?.errorText ?? 'request failed');
          });
          page.on('pageerror', (error) => checks.pageError(error.message));
          page.on('response', (response) =>
            checks.response(new URL(response.url()).pathname, response.status(), () => response.json()),
          );
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
          for (const entry of ['direct', 'navigation', 'invalidate']) {
            console.log(`Browser ${round}/${rounds} ${slug} ${variant} ${reverse} ${entry}`);
            for (let run = -2; run < runs; run++) {
              if (interrupted) throw new Error('計測を中断しました');
              let started = 0;
              if (entry === 'direct') await page.goto(`${origin}/${slug}`, { waitUntil: 'commit' });
              else if (entry === 'navigation') {
                await page.goto(`${origin}/${slug}/me`);
                await drained(page);
                started = await page.evaluate(() => {
                  performance.clearMarks();
                  return performance.now();
                });
                await page.locator(`a[href="/${slug}"]`).first().click();
              } else {
                // 前の試行の全応答が済んでから実際の app:today を無効化する。
                started = await page.evaluate(() => {
                  performance.clearMarks();
                  const at = performance.now();
                  window.dispatchEvent(new Event('bench:reload'));
                  return at;
                });
              }
              const values = await ready(page, hasTask, started);
              await checks.assertSuccess();
              if (run >= 0) samples.push({ round, case: index, variant, reverse, entry, hasTask, ...values });
            }
            save();
          }
        } finally {
          await context.close();
        }
      }
    }
  }
  report.completedAt = new Date().toISOString();
} catch (error) {
  measurementError = error;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await finishTodayBenchmark(
    save,
    [
      () => browser?.close(),
      () => tracked?.stop(),
      () =>
        new Promise<void>((resolve) => {
          if (proxy.listening) proxy.close(() => resolve());
          else resolve();
        }),
      () => restoreBuild?.(),
      () => {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
      },
      () => rmSync(dir, { recursive: true, force: true }),
    ],
    measurementError,
  );
  console.log(`結果: ${output}。使い捨て D1・計測ビルドは削除し、元の build を復元しました。`);
}
