import { expect, type Browser, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { categoryRepositoryList } from '../src/shared/operations/definition/index.ts';
import { epicDetail, epicGet } from '../src/shared/operations/epic/index.ts';
import type { EpicVariant } from './epic-loading-variant.ts';

export const epicEntries = ['direct', 'navigation', 'reload'] as const;
export type EpicEntry = (typeof epicEntries)[number];
export const workspacePath = '/aoba/w/019a0000-0000-7000-8000-000000000401';
export const epicId = '019a0000-0000-7000-8000-000000000b01';
export const epicTitle = 'ポイントの交換先を増やす';
const category = '追加案件';
const epicPath = `${workspacePath}/epics/${epicId}`;
const outputs = {
  'epic-detail': epicDetail.output,
  'epic-get': epicGet.output,
  'category-repository-list': categoryRepositoryList.output,
};

export type EpicTimings = {
  display: number;
  ready: number;
  choices: number;
  afterEditClick: number;
  primary: number;
  definitions: number | null;
  drawerEpic: number;
  drawerDefinitions: number;
  shell: number | null;
};

class Requests {
  private active = new Set<Request>();
  private validation: Promise<void>[] = [];
  private errors: string[] = [];

  constructor(page: Page, origin: string) {
    page.on('request', (request) => {
      if (new URL(request.url()).origin === origin) this.active.add(request);
    });
    page.on('requestfinished', (request) => this.active.delete(request));
    page.on('requestfailed', (request) => {
      if (this.active.delete(request))
        this.errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);
    });
    page.on('pageerror', (error) => this.errors.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin !== origin) return;
      if (response.status() >= 400) this.errors.push(`HTTP ${response.status()} ${url.pathname}`);
      const name = url.pathname.split('/').at(-1);
      if (!url.pathname.startsWith('/api/aoba/') || !name || !Object.hasOwn(outputs, name)) return;
      const schema = outputs[name as keyof typeof outputs];
      this.validation.push(
        response
          .json()
          .then((body: unknown) => {
            if (!schema.safeParse(body).success) this.errors.push(`${url.pathname}: 不正な応答`);
          })
          .catch(() => {
            this.errors.push(`${url.pathname}: JSON を読めません`);
          }),
      );
    });
  }

  async drain(page: Page) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const deadline = Date.now() + 30_000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.active.size)
      throw new Error(`応答待ち: ${[...this.active].map((request) => new URL(request.url()).pathname).join(', ')}`);
    await Promise.all(this.validation);
    this.validation = [];
    if (this.errors.length) throw new Error(this.errors.join('\n'));
  }
}

async function openPage(
  browser: Browser,
  origin: string,
): Promise<{ context: BrowserContext; page: Page; requests: Requests }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  try {
    await context.addCookies([{ name: sessionCookieName(origin), value: SEED_SESSIONS.member.token, url: origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    return { context, page, requests: new Requests(page, origin) };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function markClick(link: Locator, name: string) {
  await link.evaluate((element, mark) => {
    element.setAttribute('data-sveltekit-preload-data', 'off');
    element.addEventListener('click', () => performance.mark(mark), { capture: true, once: true });
  }, name);
}

function heading(page: Page, name = epicTitle) {
  return page.getByRole('heading', { level: 1, name, exact: true });
}

function editLink(page: Page) {
  return page.locator(`a[data-epic-id="${epicId}"][href="${epicPath}?epic_id=${epicId}"]`);
}

async function material(page: Page) {
  await heading(page).waitFor();
  await page.locator('section[aria-labelledby=epic-request] .chip.is-name', { hasText: category }).waitFor();
}

export async function measureEpic(
  browser: Browser,
  origin: string,
  entry: EpicEntry,
  variant: EpicVariant,
): Promise<EpicTimings> {
  const { context, page, requests } = await openPage(browser, origin);
  const target = new URL(epicPath, origin).href;
  try {
    if (entry === 'navigation') {
      await page.goto(origin + workspacePath);
      await page.getByRole('link', { name: epicTitle, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: epicTitle, exact: true });
      const link = drawer.locator(`a[href="${epicPath}"]`);
      await link.waitFor();
      await requests.drain(page);
      await markClick(link, 'epic-bench:navigation');
      await link.click();
      await page.waitForURL(target);
    } else if (entry === 'reload') {
      await page.goto(target, { waitUntil: 'commit' });
      await material(page);
      await requests.drain(page);
      await page.reload({ waitUntil: 'commit' });
    } else await page.goto(target, { waitUntil: 'commit' });

    await material(page);
    const display = await page.evaluate(() => performance.now());
    const edit = editLink(page);
    await edit.click({ trial: true });
    const ready = await page.evaluate(() => performance.now());
    await markClick(edit, 'epic-bench:edit');
    await edit.click();
    const field = page.getByRole('dialog', { name: epicTitle, exact: true }).getByLabel('区分', { exact: true });
    await field.locator('option', { hasText: '保守' }).waitFor({ state: 'attached' });
    await field.click({ trial: true });
    const choices = await page.evaluate(() => performance.now());
    await requests.drain(page);
    return await page.evaluate(
      ({ entry, variant, display, ready, choices }) => {
        const mark = (name: string) => performance.getEntriesByName(name, 'mark').at(-1)?.startTime;
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const start = entry === 'navigation' ? mark('epic-bench:navigation') : nav?.startTime;
        const editAt = mark('epic-bench:edit');
        if (start === undefined || editAt === undefined || (entry === 'reload' && nav?.type !== 'reload'))
          throw new Error('対象の文書または操作開始を確認できません');
        const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .filter((event) => event.startTime >= start && new URL(event.name).pathname.startsWith('/api/'))
          .sort((a, b) => a.startTime - b.startTime);
        const operation = (name: string) =>
          resources.filter((event) => new URL(event.name).pathname.endsWith('/' + name));
        const [primary] = operation('epic-detail');
        const [drawerEpic] = operation('epic-get');
        const definitions = operation('category-repository-list');
        const definitionsInDetail = variant === 'C' ? null : definitions[0];
        const definitionsInDrawer = definitions.at(-1);
        if (
          operation('epic-detail').length !== 1 ||
          operation('epic-get').length !== 1 ||
          definitions.length !== (variant === 'C' ? 1 : 2) ||
          !primary ||
          !drawerEpic ||
          !definitionsInDrawer ||
          primary.startTime >= editAt ||
          drawerEpic.startTime < editAt ||
          definitionsInDrawer.startTime < editAt ||
          (variant !== 'C' && (!definitionsInDetail || definitionsInDetail.startTime >= editAt))
        ) {
          throw new Error('詳細と引き出しの通信構成が不正です');
        }
        const shell = resources.filter((event) =>
          /\/(organization|my-organizations|token-notice|favorite-list|invitation-list|workspace)$/.test(
            new URL(event.name).pathname,
          ),
        );
        return {
          display: display - start,
          ready: ready - start,
          choices: choices - start,
          afterEditClick: choices - editAt,
          primary: primary.responseEnd - start,
          definitions: definitionsInDetail ? definitionsInDetail.responseEnd - start : null,
          drawerEpic: drawerEpic.responseEnd - start,
          drawerDefinitions: definitionsInDrawer.responseEnd - start,
          shell: shell.length ? Math.max(...shell.map((event) => event.responseEnd - start)) : null,
        };
      },
      { entry, variant, display, ready, choices },
    );
  } finally {
    await context.close();
  }
}

// 本計測をすべて終えてから使い捨て DB 上で実際に保存する。保存時間は集計しない。
export async function verifyEpicRefresh(browser: Browser, origin: string) {
  const { context, page, requests } = await openPage(browser, origin);
  try {
    await page.goto(origin + epicPath);
    await material(page);
    await editLink(page).click();
    const drawer = page.getByRole('dialog', { name: epicTitle, exact: true });
    await drawer.getByRole('heading', { level: 2 }).getByRole('button').click();
    const field = drawer.getByRole('textbox', { name: 'タイトル' });
    const title = 'ポイントの使い道を増やす';
    await field.fill(title);
    const saved = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/epic-update') && response.ok(),
    );
    await field.press('Enter');
    await saved;
    const panel = page.locator('.drawer');
    await panel.locator('h2', { hasText: title }).waitFor();
    await panel.locator('.drawer-close').click();
    await panel.waitFor({ state: 'hidden' });
    await expect(heading(page, title)).toBeVisible({ timeout: 15_000 });
    await requests.drain(page);
  } finally {
    await context.close();
  }
}
