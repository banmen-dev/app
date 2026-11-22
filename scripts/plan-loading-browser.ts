import { type Browser, type Page, type Request, type Response } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { planSummary, sprintList } from '../src/shared/operations/sprint/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import type { planBrowserFixtures } from './plan-loading-browser-fixture.ts';

export const planEntries = ['direct', 'navigation', 'sprints', 'backlog-tree'] as const;
type Entry = (typeof planEntries)[number];
type Fixture = (typeof planBrowserFixtures)[number];
type Variant = 'B' | 'C';
const stateSelector = '#bench-plan-state';
const timeout = 30000;

function observe(page: Page, origin: string) {
  const pending = new Set<Request>();
  const responses: Response[] = [];
  const names: string[] = [];
  const errors: string[] = [];
  const local = (url: string) => url.startsWith(`${origin}/`);
  const name = (url: string) => new URL(url).pathname.split('/').at(-1);
  page.on('request', (request) => {
    if (!local(request.url())) return;
    pending.add(request);
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/'))
      names.push(name(request.url())!);
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => {
    if (!local(request.url())) return;
    pending.delete(request);
    errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? '通信失敗'}`);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (!local(response.url())) return;
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    if (name(response.url()) === sprintList.name || name(response.url()) === planSummary.name) responses.push(response);
  });
  async function drain() {
    const end = Date.now() + timeout;
    while (pending.size > 0) {
      if (Date.now() > end)
        throw new Error(`未完了の通信: ${[...pending].map((item) => new URL(item.url()).pathname).join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const response of responses.splice(0)) {
      const operation = name(response.url()) === sprintList.name ? sprintList : planSummary;
      if (!operation.output.safeParse(await response.json()).success)
        errors.push(`${operation.name}: 出力スキーマが不正`);
    }
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }
  return { names, drain };
}

async function openPage(browser: Browser, origin: string, fixture: Fixture) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  try {
    await context.addCookies([{ name: sessionCookieName(origin), value: SEED_SESSIONS.member.token, url: origin }]);
    await context.addInitScript(
      ({ fixture, stateSelector }) => {
        performance.setResourceTimingBufferSize(2000);
        const observer = new MutationObserver(() => {
          if (!document.body) return;
          document.body.setAttribute('data-sveltekit-preload-data', 'off');
          observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
        const planPath = `/${fixture.slug}/w/${fixture.workspaceId}/plan`;
        let generation = '';
        let previousList = false;
        let previousSummary = false;
        let list = false;
        let operation = false;
        let summary = false;
        const visible = (element: Element | null | undefined) =>
          element?.checkVisibility({ visibilityProperty: true }) === true;
        const actionable = (control: Element | null | undefined) => {
          if (!control || !visible(control) || control.getAttribute('aria-disabled') === 'true') return false;
          if (getComputedStyle(control).pointerEvents === 'none') return false;
          const box = control.getBoundingClientRect();
          if (!box.width || !box.height) return false;
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          // 画面外のレーンはスクロール後に試行クリックで検証する。計時にはスクロールを含めない。
          return (
            x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || control.contains(document.elementFromPoint(x, y))
          );
        };
        const frame = () => {
          const state = document.querySelector<HTMLElement>(stateSelector);
          const current = state?.dataset.generation;
          if (location.pathname === planPath && current) {
            if (generation !== current) {
              generation = current;
              previousList = previousSummary = list = operation = summary = false;
            }
            const lane = fixture.laneId
              ? document.querySelector(`[data-lane-title="${fixture.laneId}"]`)?.closest('.lane')
              : null;
            const row = fixture.taskId ? lane?.querySelector(`[data-row-id="${fixture.taskId}"]`) : null;
            const listVisible =
              fixture.key === 'empty'
                ? state?.dataset.listEmpty === 'true' && visible(document.querySelector('main .empty'))
                : visible(lane) && visible(row);
            if (!list && listVisible && previousList) {
              list = true;
              performance.mark(`bench:list:${generation}`);
            }
            previousList = listVisible;
            if (!operation && fixture.key !== 'empty') {
              const control =
                fixture.key === 'closed'
                  ? row?.querySelector('a[data-task-id]')
                  : lane?.querySelector<HTMLButtonElement>(`[data-sprint-add="${fixture.laneId}"]:not(:disabled)`);
              if (actionable(control)) {
                operation = true;
                performance.mark(`bench:operation:${generation}`);
              }
            }
            const summaryVisible =
              state?.dataset.summaryReady === 'true' &&
              (fixture.key === 'empty'
                ? listVisible
                : visible(document.querySelector('[data-velocity-average]')) &&
                  visible(document.querySelector('.page-head .tally')) &&
                  visible(document.querySelector(`[data-velocity-sprint="${fixture.velocitySprintId}"]`)) &&
                  visible(document.querySelector(`[data-plan-epic="${fixture.summaryEpicId}"] a`)) &&
                  visible(lane?.querySelector('[data-lane-fill]')));
            if (!summary && summaryVisible && previousSummary) {
              summary = true;
              performance.mark(`bench:summary:${generation}`);
            }
            previousSummary = summaryVisible;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      },
      { fixture, stateSelector },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    return { page, context, ...observe(page, origin) };
  } catch (error) {
    await context.close();
    throw error;
  }
}

type ObservedPage = Awaited<ReturnType<typeof openPage>>;

async function generationOf(page: Page) {
  return await page.locator(stateSelector).getAttribute('data-generation');
}

async function readiness(page: Page, old: string | null, fixture: Fixture, started: number) {
  const value = await page.waitForFunction(
    ({ stateSelector, old, hasOperation, started }) => {
      const generation = document.querySelector<HTMLElement>(stateSelector)?.dataset.generation;
      if (!generation || generation === old) return false;
      const at = (name: string) => performance.getEntriesByName(`bench:${name}:${generation}`, 'mark')[0]?.startTime;
      const list = at('list');
      const operation = hasOperation ? at('operation') : null;
      const summary = at('summary');
      const load = at('load');
      const listResponse = at('list-response');
      const summaryResponse = at('summary-response');
      if (
        list === undefined ||
        operation === undefined ||
        summary === undefined ||
        load === undefined ||
        listResponse === undefined ||
        summaryResponse === undefined
      )
        return false;
      return {
        generation,
        list: list - started,
        operation: operation === null ? null : operation - started,
        summary: summary - started,
        load: load - started,
        listResponse: listResponse - started,
        summaryResponse: summaryResponse - started,
      };
    },
    { stateSelector, old, hasOperation: fixture.key !== 'empty', started },
  );
  const times = await value.jsonValue();
  if (!times) throw new Error('計測時刻がありません');
  return times;
}

const workspacePath = (fixture: Fixture) => `/${fixture.slug}/w/${fixture.workspaceId}`;
const operationControl = (page: Page, fixture: Fixture) =>
  page.locator(
    fixture.key === 'closed' ? `.lane a[data-task-id="${fixture.taskId}"]` : `[data-sprint-add="${fixture.laneId}"]`,
  );

async function measure(session: ObservedPage, origin: string, fixture: Fixture, entry: Entry) {
  const { page, names, drain } = session;
  const workspace = workspacePath(fixture);
  let old: string | null = null;
  let started = 0;
  names.length = 0;
  if (entry === 'direct') {
    await page.goto(`${origin}${workspace}/plan`, { waitUntil: 'commit' });
  } else if (entry === 'navigation') {
    if (page.url() === `${origin}${workspace}/plan`) {
      old = await generationOf(page);
      await page.goBack({ waitUntil: 'commit' });
      await page.locator(stateSelector).waitFor({ state: 'detached' });
    } else {
      await page.goto(`${origin}${workspace}`, { waitUntil: 'domcontentloaded' });
    }
    if (page.url() !== `${origin}${workspace}`) throw new Error('計画へ移る前のバックログに戻れません');
    const link = page.locator(`a[href="${workspace}/plan"]:visible`).first();
    await link.evaluate((element) => element.setAttribute('data-sveltekit-preload-data', 'off'));
    await link.click({ trial: true });
    await drain();
    if (names.includes(sprintList.name) || names.includes(planSummary.name))
      throw new Error('計画がリンク操作前に先読みされました');
    names.length = 0;
    await link.evaluate((element) =>
      element.addEventListener('click', () => performance.mark('bench:click'), { once: true, capture: true }),
    );
    await link.click();
    started = await page.evaluate(() => performance.getEntriesByName('bench:click', 'mark').at(-1)!.startTime);
  } else {
    old = await generationOf(page);
    const dependency = entry === 'sprints' ? 'app:sprints' : 'app:backlog-tree';
    started = await page.evaluate((key) => {
      const now = performance.now();
      window.dispatchEvent(new CustomEvent('bench:plan-invalidate', { detail: key }));
      return now;
    }, dependency);
  }
  const times = await readiness(page, old, fixture, started);
  if (fixture.key !== 'empty') {
    await operationControl(page, fixture).click({ trial: true });
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await drain();
  const sent = names.filter((name) => name === sprintList.name || name === planSummary.name);
  if (sent.join(',') !== 'sprint-list,plan-summary')
    throw new Error(`計画 API の発行件数または順番が不正です: ${sent.join(',')}`);
  if (fixture.key === 'closed') {
    const writeControls = page
      .locator('[data-sprint-add]')
      .or(page.locator('.lane').getByRole('button', { name: /外す/ }));
    if ((await writeControls.count()) !== 0) throw new Error('終了済みの計画に書き込み操作があります');
  }
  const diagnostic = await page.evaluate((started) => {
    return (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).flatMap((item) => {
      const url = new URL(item.name);
      if (item.startTime < started || url.origin !== location.origin || !url.pathname.startsWith('/api/')) return [];
      return [
        {
          operation: url.pathname.split('/').at(-1),
          started: item.startTime - started,
          finished: item.responseEnd - started,
        },
      ];
    });
  }, started);
  return { ...times, diagnostic };
}

type Sample = Awaited<ReturnType<typeof measure>>;

export async function measurePlanCell(
  browser: Browser,
  origin: string,
  fixture: Fixture,
  entry: Entry,
  runs: number,
  record: (run: number, sample: Sample) => void,
  interrupted: () => boolean,
) {
  let session: ObservedPage | undefined;
  try {
    if (entry !== 'direct') {
      session = await openPage(browser, origin, fixture);
      if (entry !== 'navigation') {
        await session.page.goto(`${origin}${workspacePath(fixture)}/plan`, { waitUntil: 'commit' });
        await readiness(session.page, null, fixture, 0);
        await session.drain();
      }
    }
    for (let run = -1; run <= runs; run++) {
      if (interrupted()) throw new Error('計測を中断しました');
      const current = session ?? (await openPage(browser, origin, fixture));
      try {
        const sample = await measure(current, origin, fixture, entry);
        if (run > 0) record(run, sample);
      } catch (error) {
        throw new Error(`${run > 0 ? `記録${run}` : `温め${run + 2}`}: ${String(error)}`, { cause: error });
      } finally {
        if (!session) await current.context.close();
      }
    }
  } finally {
    await session?.context.close();
  }
}

export async function verifyPlanOperation(browser: Browser, origin: string, fixture: Fixture, variant: Variant) {
  const session = await openPage(browser, origin, fixture);
  try {
    const { page, drain } = session;
    const hold = Promise.withResolvers<void>();
    if (variant === 'C' && fixture.key === 'planned')
      await page.route('**/api/*/plan-summary', async (route) => {
        await hold.promise;
        await route.continue();
      });
    try {
      await page.goto(`${origin}${workspacePath(fixture)}/plan`, { waitUntil: 'commit' });
      await operationControl(page, fixture).click();
      await page.getByRole('dialog').filter({ visible: true }).waitFor({ state: 'visible' });
      if (
        variant === 'C' &&
        fixture.key === 'planned' &&
        (await page.locator(stateSelector).getAttribute('data-summary-ready')) !== 'false'
      )
        throw new Error('集計待ちの間に一覧を操作できることを確認できませんでした');
    } finally {
      hold.resolve();
    }
    await readiness(page, null, fixture, 0);
    await drain();
  } finally {
    await session.context.close();
  }
}

export async function verifyPlanUpdates(browser: Browser, origin: string, fixture: Fixture) {
  const { page, context, drain } = await openPage(browser, origin, fixture);
  try {
    await page.goto(`${origin}${workspacePath(fixture)}/plan`, { waitUntil: 'commit' });
    await readiness(page, null, fixture, 0);
    const lane = page.locator('.lane').filter({ has: page.locator(`[data-lane-title="${fixture.laneId}"]`) });
    const row = lane.locator(`[data-row-id="${fixture.taskId}"]`);
    const fill = lane.locator('[data-lane-fill] .lane-fill-text span').first();
    const original = await fill.textContent();

    let previous = await generationOf(page);
    await row.locator('a[data-task-id]').click();
    const drawer = page.getByRole('dialog').filter({ visible: true });
    await drawer.getByRole('radio', { name: '5', exact: true }).check();
    await readiness(page, previous, fixture, 0);
    if ((await row.locator('.pts').textContent())?.trim() !== '5' || (await fill.textContent()) === original)
      throw new Error('タスク編集後に一覧と集計が更新されませんでした');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    await drain();

    // 「外す」は app:sprints の再読み取りを行う。対象の行が無くなるので集計の世代と表示を直接確認する。
    previous = await generationOf(page);
    await row.getByRole('button', { name: /外す/ }).click();
    await row.waitFor({ state: 'detached' });
    await page.waitForFunction(
      ({ previous, stateSelector }) => {
        const state = document.querySelector<HTMLElement>(stateSelector);
        return (
          state?.dataset.generation && state.dataset.generation !== previous && state.dataset.summaryReady === 'true'
        );
      },
      { previous, stateSelector },
    );
    if ((await fill.textContent()) !== original)
      throw new Error('スプリントから外した後に積載量が更新されませんでした');
    await drain();
  } finally {
    await context.close();
  }
}
