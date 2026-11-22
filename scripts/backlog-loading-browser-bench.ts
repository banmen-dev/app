// node scripts/backlog-loading-browser-bench.ts [--runs 20] [--rounds 2] [--port 9850] [--output /tmp/backlog-loading.json]
// 製品コードは編集せず、使い捨て D1 と計測専用 B/C ビルドを使う。
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuilder } from 'vite';
import { chromium, type Browser, type Page, type Request } from '@playwright/test';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { backlogTree } from '../src/shared/operations/task/index.ts';
import { sessionInserts } from './seed.ts';
import { fillSeedDates } from './seed-dates.ts';
import { backlogTrial, type BacklogOperation } from './backlog-loading-trial.ts';
import { TEST_CREDENTIAL_KEYS } from './test-credential-keys.ts';
import { finishTodayBenchmark, preserveTodayBuild } from './today-loading-support.ts';
import { BacklogBrowserChecks, backlogOutputs, collectBacklogReadiness } from './backlog-loading-support.ts';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { bootProxy } from './boot-proxy.ts';
import {
  backlogCases,
  backlogPath,
  backlogSlug,
  backlogLoadingFixture,
  backlogTaskCount,
} from './backlog-loading-fixture.ts';
import { backlogLoadingPlugin, type BacklogVariant } from './backlog-loading-variant.ts';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} の値がありません`);
  return value;
}
const runs = Number(option('--runs', '20'));
const rounds = Number(option('--rounds', '2'));
const port = Number(option('--port', '9850'));
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
const output = path.resolve(option('--output', path.join(tmpdir(), 'backlog-loading.json')));
const root = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), 'banmen-backlog-'));
const origin = `http://127.0.0.1:${port}`;
const config = path.join(dir, 'wrangler.json');
const version = `backlog-loading-${randomUUID()}`;
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
      name: 'backlog-loading-bench',
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
          database_name: 'backlog-loading-bench',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: path.join(root, 'migrations'),
        },
      ],
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'backlog-loading-bench' }],
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
async function read(index: number, operation: BacklogOperation) {
  const condition = backlogCases[index]!;
  const name = (['backlog-tree', 'category-repository-list'] as const)[operation];
  const response = await fetch(`${origin}/api/${backlogSlug}/${name}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: `${sessionCookieName(origin)}=${SEED_SESSIONS.member.token}`,
    },
    body: JSON.stringify({ workspace_id: condition.workspaceId, ...(operation === 0 ? condition.input : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  const body: unknown = await response.json();
  return {
    body,
    finishedAt: performance.now(),
    validate: () => {
      if (!response.ok || !backlogOutputs[name]!.safeParse(body).success)
        throw new Error(`${name}: HTTP ${response.status} または出力が不正`);
    },
  };
}
type ApiSample = {
  round: number;
  case: number;
  variant: 'A' | BacklogVariant;
  reverse: boolean;
  trial: number;
  definitions: number | null;
  primary: number;
  load: number;
  total: number;
};
type BrowserSample = {
  round: number;
  case: number;
  variant: BacklogVariant;
  reverse: boolean;
  entry: string;
  primary: number;
  trial: number;
  definitions: number;
  choices: number;
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
  inputHashes: Object.fromEntries(
    readdirSync(path.join(root, 'scripts'))
      .filter((name) => /^backlog-loading-.*\.ts$/.test(name))
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(path.join(root, 'scripts', name)))
          .digest('hex'),
      ]),
  ),
  cache: 'CDP cache disabled; service workers blocked',
  network: 'loopback, no artificial delay or network throttling',
  fixture: { tasks: backlogTaskCount, cases: backlogCases, fixedAt: '2026-11-16T00:00:00.000Z' },
  wrangler: command('wrangler', ['--version'], root).trim(),
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
    if (Date.now() > until)
      throw new Error(
        '前の試行の通信が完了しません: ' +
          JSON.stringify(
            [...requests.get(page)!].map((request) => ({
              path: new URL(request.url()).pathname,
              type: request.resourceType(),
            })),
          ),
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function setNavigationLink(page: Page, target: string) {
  await page.evaluate((href) => {
    let link = document.querySelector<HTMLAnchorElement>('#bench-navigation');
    if (!link) {
      link = document.createElement('a');
      link.id = 'bench-navigation';
      link.textContent = '計測へ';
      link.setAttribute('data-sveltekit-preload-data', 'off');
      document.body.append(link);
    }
    link.href = href;
  }, target);
}
async function ready(page: Page, index: number, started: number, previousVersion = '') {
  const condition = backlogCases[index]!;
  // filterは空欄も含む正規化値。新しい木の読取世代とURL値を両方確かめる。
  const expected = { assignee: '', category: '', repository: '', epic: '', delegatee: '', q: '', ...condition.query };
  await page.waitForFunction(
    ({ expected, previousVersion }) => {
      const state = document.querySelector<HTMLElement>('#bench-state');
      if (!state || state.dataset.readVersion === previousVersion) return false;
      return state.dataset.filter === JSON.stringify(expected) && performance.getEntriesByName('bench:load').length > 0;
    },
    { expected, previousVersion },
  );
  const choicesReady = (async () => {
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#bench-state')?.dataset.definitionsReady === 'true',
    );
    // 100件の木には区分とrepositoryがある。実際のselectへ反映されたことも確認する。
    if (index !== 3) {
      await page
        .locator('[role="search"] select')
        .nth(1)
        .locator('option', { hasText: '計測の区分' })
        .waitFor({ state: 'attached' });
      await page
        .locator('[role="search"] select')
        .nth(2)
        .locator('option', { hasText: 'bench-work' })
        .waitFor({ state: 'attached' });
      await page
        .locator('[role="search"] select')
        .nth(1)
        .evaluate((select) => {
          if ((select as HTMLSelectElement).disabled) throw new Error('区分の選択欄がまだ無効です');
        });
    }
    return await page.evaluate(() => performance.now());
  })();
  const [value, choices] = await collectBacklogReadiness(
    (async () => {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      if (condition.hasTask) {
        const row = page.locator(`.entry[data-row-id="${condition.targetTaskId}"]`);
        await row.locator('button.done-btn').click({ trial: true, timeout: 10000 });
      } else {
        await page.locator('.empty').waitFor({ state: 'visible' });
      }
      return await page.evaluate(() => ({
        ready: performance.now(),
        primary: performance.getEntriesByName('bench:primary').at(-1)!.startTime,
        load: performance.getEntriesByName('bench:load').at(-1)!.startTime,
      }));
    })(),
    choicesReady,
  );
  await page.waitForFunction(() => performance.getEntriesByName('bench:definitions').length > 0);
  await drained(page);
  const rest = await page.evaluate(() => ({
    definitions: performance.getEntriesByName('bench:definitions').at(-1)!.startTime,
    shell: Math.max(
      0,
      ...performance
        .getEntriesByType('resource')
        .filter((entry) =>
          /\/(organization|my-organizations|token-notice|favorite-list|invitation-list|workspace)$/.test(
            new URL(entry.name).pathname,
          ),
        )
        .map((entry) => (entry as PerformanceResourceTiming).responseEnd),
    ),
  }));
  return {
    primary: value.primary - started,
    load: value.load - started,
    ready: value.ready - started,
    definitions: rest.definitions - started,
    choices: choices - started,
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
      await (await createBuilder({ plugins: [backlogLoadingPlugin(variant, reverse)] })).buildApp();
      cpSync(path.join(root, 'build'), path.join(dir, `${variant}-${reverse}`), { recursive: true });
    }
  restoreBuild();
  configuration(path.join(dir, 'B-false'));
  const fixture = path.join(dir, 'fixture.sql');
  writeFileSync(
    fixture,
    fillSeedDates(readFileSync(path.join(root, 'seed/data.sql'), 'utf8'), new Date()) +
      sessionInserts(Object.values(SEED_SESSIONS), new Date()) +
      backlogLoadingFixture(),
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
    for (const [index, condition] of backlogCases.entries()) {
      const mainRead = await read(index, 0);
      mainRead.validate();
      const main = backlogTree.output.parse(mainRead.body);
      const taskIds = [...main.tasks, ...main.stories.flatMap((story) => story.tasks)].map((task) => task.id);
      if (
        condition.hasTask !== taskIds.includes(condition.targetTaskId ?? '') ||
        (!condition.hasTask && taskIds.length !== 0)
      )
        throw new Error(`${condition.name}: 木のタスク条件が不正`);
      for (const reverse of [false, true])
        for (const variant of (round % 2 ? ['A', 'B', 'C'] : ['C', 'B', 'A']) as ('A' | BacklogVariant)[]) {
          console.log(`API ${round}/${rounds} ${condition.name} ${variant} ${reverse}`);
          for (let run = -2; run < runs; run++) {
            const value = await backlogTrial(variant, reverse, (operation) => read(index, operation));
            if (run >= 0)
              api.push({
                round,
                case: index,
                trial: run,
                variant,
                reverse,
                primary: value.primary,
                definitions: value.definitions,
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
      for (const [index, condition] of backlogCases.entries()) {
        const slug = backlogSlug;
        const hasTask = condition.hasTask;
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
          const checks = new BacklogBrowserChecks();
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
          for (const entry of ['direct', 'navigation', 'invalidate', 'filter']) {
            console.log(`Browser ${round}/${rounds} case=${index} ${condition.name} ${variant} ${reverse} ${entry}`);
            for (let run = -2; run < runs; run++) {
              if (interrupted) throw new Error('計測を中断しました');
              let started = 0;
              let previousVersion = '';
              if (entry === 'direct') await page.goto(`${origin}${backlogPath(index)}`, { waitUntil: 'commit' });
              else if (entry === 'navigation') {
                // 戻る側もSPAで移り、画面内遷移の計測へ文書全体の再起動を混ぜない。
                await setNavigationLink(page, `/${slug}/me`);
                await page.locator('#bench-navigation').click();
                await page.waitForFunction(() => document.querySelector('#bench-state') === null);
                await drained(page);
                await setNavigationLink(page, backlogPath(index));
                started = await page.evaluate(() => {
                  performance.clearMarks();
                  return performance.now();
                });
                await page.locator('#bench-navigation').click();
              } else {
                const target = `${origin}${backlogPath(index)}`;
                if (entry === 'filter') {
                  // 計測前に別条件の木へSPAで変え、応答・描画・全通信完了を待つ。
                  const version = await page.locator('#bench-state').getAttribute('data-read-version');
                  await page.evaluate(() =>
                    window.dispatchEvent(new CustomEvent('bench:filter', { detail: '?q=計測前の別条件' })),
                  );
                  await page.waitForFunction((previous) => {
                    const state = document.querySelector<HTMLElement>('#bench-state');
                    return (
                      state &&
                      state.dataset.readVersion !== previous &&
                      JSON.parse(state.dataset.filter!).q === '計測前の別条件'
                    );
                  }, version);
                  await drained(page);
                }
                previousVersion = (await page.locator('#bench-state').getAttribute('data-read-version')) ?? '';
                started = await page.evaluate(
                  ({ entry, search }) => {
                    performance.clearMarks();
                    const at = performance.now();
                    window.dispatchEvent(
                      entry === 'filter'
                        ? new CustomEvent('bench:filter', { detail: search })
                        : new Event('bench:reload'),
                    );
                    return at;
                  },
                  { entry, search: new URL(target).search },
                );
              }
              const values = await ready(page, index, started, previousVersion);
              await checks.assertSuccess();
              if (run >= 0)
                samples.push({ round, case: index, trial: run, variant, reverse, entry, hasTask, ...values });
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
