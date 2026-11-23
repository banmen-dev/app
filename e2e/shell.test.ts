import type { Locator, Page } from '@playwright/test';
import { tokenCreate } from '../src/shared/operations/session/index.ts';
import {
  firstSteps,
  myOrganizations,
  organizationInfo,
  recentActivity,
  today as todayOperation,
} from '../src/shared/operations/organization/index.ts';
import { orgWikiTree } from '../src/shared/operations/wiki/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { failOperation, mockOperation, rewriteOperation, routeOperation } from './operations.ts';
import {
  expectFocusReturned,
  expectModalFocus,
  expectNoA11yViolationsInThemes,
  signIn,
  watchViolations,
} from './helpers.ts';
import { exclusionsFor, isAxeCheck } from './ui-exclusions.ts';

// build と wrangler dev に渡した版。playwright.config.ts が決めて process.env に置く（docs/development.md の「e2e のサーバー」）
const version = process.env.APP_VERSION || 'dev';

// 枠の部品は組織の中の画面が使う。あおば開発だけに入れるユーザー（ハルカ）で、組織の画面を開く
const today = '/aoba';
// あおば開発のワークスペース（seed）。バックログの木の行が本文の左端に並ぶ
const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'member');
});

test('組織の画面はシェルを返し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto(today);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('1280px では左のメニューを折りたため、幅とラベルと状態を覚える', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.evaluate(() => localStorage.removeItem('sg-nav-collapsed'));
  await page.reload();

  const app = page.locator('.app');
  const toggle = page.getByRole('button', { name: 'メニューを畳む' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-controls', 'app-nav');
  const before = await page.locator('.content').boundingBox();
  await toggle.click();
  const expand = page.getByRole('button', { name: 'メニューを広げる' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  // 押してもフォーカスはボタンに残る
  await expect(expand).toBeFocused();
  await expect(app).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 64);
  const after = await page.locator('.content').boundingBox();
  expect(after!.x).toBeLessThan(before!.x);

  // 今のページは、太字の名前の代わりに左の縦棒（縁）で示す
  // 縁の色は今のページのアイコンと同じ（操作の色）。縦棒は列の端でなく項目の左端に重ね（罫の太さで位置がにじまない）、
  // 64px の列の内側に収まる
  const bar = await page.locator('#app-nav .nav-item[aria-current="page"]').evaluate((el) => {
    const before = getComputedStyle(el, '::before');
    const item = el.getBoundingClientRect();
    return {
      width: before.borderLeftWidth,
      color: before.borderLeftColor,
      icon: getComputedStyle(el.querySelector('.ico')!).color,
      offset: before.left,
      left: item.left + parseFloat(before.left),
    };
  });
  expect(bar.width).toBe('3px');
  expect(bar.color).toBe(bar.icon);
  expect(bar.offset).toBe('0px');
  expect(bar.left).toBeGreaterThanOrEqual(0);
  expect(bar.left + 3).toBeLessThanOrEqual(64);

  // 項目はアイコンだけで、名前は見えないが読み上げには残る
  const item = page.locator('.nav-item').first();
  await expect(item.locator('.nav-item-label')).toHaveCSS('opacity', '0');
  await expect(page.locator('#app-nav').getByRole('link', { name: '今日やること' })).toBeVisible();
  // 角のマスはマークのリンクだけになり、組織の切り替えは上の帯の右に名前のまま残る（#1510）
  await expect(page.locator('.binding-head .brand')).toBeVisible();
  await expect(page.locator('.binding-head .brand')).toHaveAttribute('href', '/aoba');
  await expect(page.locator('.binding-head .org-menu')).toHaveCount(0);
  await expect(page.locator('.topbar .org-menu-button > b')).toBeVisible();

  // 再読み込みしても畳んだまま。キーボードだけで広げられる
  await page.reload();
  await expect(app).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 64);
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'メニューを畳む' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 240);
  await page.keyboard.press('Space');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect(await collect()).toEqual([]);
});

test('畳んだ列では、マウスを載せるかフォーカスすると項目の名前が横に見える', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  const items = page.locator('#app-nav .nav-item');
  // キーボードで移ると名前が出る（開閉のボタンから Tab で最初の項目へ）
  await page.getByRole('button', { name: 'メニューを広げる' }).focus();
  for (let i = 0; i < 5 && !(await items.nth(0).evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(items.nth(0)).toBeFocused();
  await expect(items.nth(0).locator('.nav-item-label')).toHaveCSS('opacity', '1');
  // 組織の画面の左のメニューは「今日やること」の1項目だけ。フォーカスを外し、マウスを載せて名前が出ることを見る
  await items.nth(0).evaluate((el) => (el as HTMLElement).blur());
  await page.mouse.move(700, 600);
  await expect(items.nth(0).locator('.nav-item-label')).toHaveCSS('opacity', '0');
  await items.nth(0).hover();
  await expect(items.nth(0).locator('.nav-item-label')).toHaveCSS('opacity', '1');
  // 名前は列の外（右）に浮く
  const label = await items.nth(0).locator('.nav-item-label').boundingBox();
  expect(label!.x).toBeGreaterThanOrEqual(64);

  // マウスで押した後は、マウスを外せば名前が消える（押したリンクにフォーカスが残っても出し続けない）
  await items.nth(0).click();
  await page.mouse.move(700, 600);
  await expect(items.nth(0).locator('.nav-item-label')).toHaveCSS('opacity', '0');
});

// 浮かせた名前の中の点が、本文の要素に覆われずに名前自身を返すか（名前は pointer-events: none なので、測る間だけ戻す）
async function frontmostAcross(page: Page, selector: string): Promise<boolean[]> {
  return page.locator(selector).evaluate((el: HTMLElement) => {
    el.style.pointerEvents = 'auto';
    const r = el.getBoundingClientRect();
    const hits = [0.1, 0.5, 0.9].map((f) => {
      const hit = document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2);
      return hit !== null && el.contains(hit);
    });
    el.style.pointerEvents = '';
    return hits;
  });
}

test('畳んだ列の名前と組織の一覧は、バックログの行に覆われず、列の外に出る', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
  await expect(page.locator('.tree-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'メニューを畳む' }).click();

  const backlog = page.locator('#app-nav').getByRole('link', { name: 'バックログ' });
  await backlog.hover();
  const label = backlog.locator('.nav-item-label');
  await expect(label).toHaveCSS('opacity', '1');
  const labelBox = await label.boundingBox();
  const itemBox = await backlog.boundingBox();
  expect(labelBox!.x).toBeCloseTo(itemBox!.x + itemBox!.width + 12, 0);
  expect(labelBox!.y + labelBox!.height / 2).toBeCloseTo(itemBox!.y + itemBox!.height / 2, 0);
  expect(await frontmostAcross(page, '#app-nav .nav-item[aria-current="page"] .nav-item-label')).toEqual([
    true,
    true,
    true,
  ]);
});

test('760px 以下では、畳んだままでも下のタブバーと浮きメニューを出す', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(page.locator('.nav-toggle')).toBeHidden();
  await expect(page.locator('.binding')).toHaveCount(0);
  await expect(page.locator('.mobile-tabs')).toBeVisible();
  await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
  await expect(page.locator('.nav-item-label').first()).toHaveCSS('opacity', '1');
});

test('760px 以下では、押したタブの読み込みを待つ間も先に選んだ印を移す', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${today}/favorites`);
  const tabs = page.locator('.mobile-tabs');
  const todayTab = tabs.getByRole('link', { name: '今日やること', exact: true });
  const favoritesTab = tabs.getByRole('link', { name: 'お気に入り', exact: true });
  await expect(favoritesTab).toHaveAttribute('aria-current', 'page');

  // 今日やることの読み込み（today と firstSteps の操作）を止めておき、待っている間の見た目を確かめる
  const release = await holdOperations(page, todayOperation, firstSteps);
  await todayTab.click();
  await expect(todayTab).toHaveAttribute('data-selected', '');
  await expect(favoritesTab).not.toHaveAttribute('data-selected');
  // 読み上げの現在地は、着くまで元の画面に残す
  await expect(favoritesTab).toHaveAttribute('aria-current', 'page');
  await expect(todayTab).not.toHaveAttribute('aria-current');
  const selectedBorder = await selectedTabBorder(page);
  await expect(todayTab).toHaveCSS('border-top-color', selectedBorder);
  await expect(favoritesTab).not.toHaveCSS('border-top-color', selectedBorder);

  release();
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  await expect(todayTab).toHaveAttribute('aria-current', 'page');
  await expect(todayTab).toHaveAttribute('data-selected', '');
  await expect(favoritesTab).not.toHaveAttribute('data-selected');
});

test('760px 以下でタブで無い画面へ移る間は、今のタブの印を残す', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${today}/favorites`);
  const tabs = page.locator('.mobile-tabs');
  const favoritesTab = tabs.getByRole('link', { name: 'お気に入り', exact: true });
  await expect(favoritesTab).toHaveAttribute('data-selected', '');

  // 組織の Wiki（タブに無い画面）の読み込みを止め、浮きメニューから移る
  const release = await holdOperations(page, orgWikiTree);
  await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('link', { name: /の Wiki$/ })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(favoritesTab).toHaveAttribute('data-selected', '');
  await expect(favoritesTab).toHaveAttribute('aria-current', 'page');
  await expect(tabs.locator('[data-selected]')).toHaveCount(1);

  release();
  await expect(page).toHaveURL(/\/aoba\/wiki$/);
  await expect(tabs.locator('[data-selected]')).toHaveCount(0);
});

test.describe('画面の入れ替え（View Transitions）', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & { fadeCount?: number };
      w.fadeCount = 0;
      const original = document.startViewTransition?.bind(document);
      if (!original) return;
      document.startViewTransition = ((update: () => Promise<void>) => {
        w.fadeCount! += 1;
        return original(update);
      }) as unknown as typeof document.startViewTransition;
    });
  });
  const fadeCount = (page: Page) => page.evaluate(() => (window as Window & { fadeCount?: number }).fadeCount);

  test('760px 以下のタブの移動で入れ替え、戻るでは入れ替えない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${today}/favorites`);
    expect(await page.evaluate(() => typeof document.startViewTransition)).toBe('function');
    await page.locator('.mobile-tabs').getByRole('link', { name: '今日やること', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect.poll(() => fadeCount(page)).toBe(1);

    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'お気に入り' })).toBeVisible();
    expect(await fadeCount(page)).toBe(1);
  });

  test('動きを減らす設定では入れ替えない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${today}/favorites`);
    await page.locator('.mobile-tabs').getByRole('link', { name: '今日やること', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    expect(await fadeCount(page)).toBe(0);
  });

  test('761px 以上では入れ替えない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${today}/favorites`);
    await page.locator(`#app-nav a[href="${today}"]`).click();
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    expect(await fadeCount(page)).toBe(0);
  });
});

// 行き先の操作の応答を止めておき、返す関数で流す。流した後に来た呼び出しもそのまま通す。
// 流した直後に unroute すると、止めていた呼び出しが既に処理済みになり route が投げるので、テストの終わりまで外さない
async function holdOperations(
  page: Page,
  ...operations: (typeof todayOperation | typeof firstSteps | typeof orgWikiTree)[]
): Promise<() => void> {
  const gate = Promise.withResolvers<void>();
  for (const operation of operations) {
    await routeOperation(page, operation, { slug: 'aoba' }, async (call) => {
      await gate.promise;
      await call.passThrough();
    });
  }
  return gate.resolve;
}

// 選んだタブの縁の色（--color-line）。待つ間の行き先のタブが、現在地と同じ見た目になることを確かめる
async function selectedTabBorder(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('a');
    probe.className = 'mobile-tab';
    probe.dataset.selected = '';
    document.body.append(probe);
    const color = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return color;
  });
}

test.describe('ホバーのできない端末（1024px の指のタブレット）', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test('覚えた状態が畳んだでも、開閉のボタンを出さず、広げた列で出す', async ({ page }) => {
    await page.goto(today);
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    await page.evaluate(() => localStorage.setItem('sg-nav-collapsed', 'true'));
    await page.reload();
    await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
    await expect(page.locator('.nav-toggle')).toBeHidden();
    await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 240);
    // 角のマスは広げた列の形（マークのリンク）のまま。組織の名前は上の帯の右に出る
    await expect(page.locator('.binding-head .brand')).toBeVisible();
    await expect(page.locator('.topbar .org-menu-button > b')).toBeVisible();
    await expect(page.locator('#app-nav .nav-item-label').first()).toHaveCSS('opacity', '1');
  });
});

test.describe('高さの低い指で押す画面の左のメニュー', () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  // overflows: Wiki と接続を含む列は 1024×680 以下で溢れ、1024×768 では余白まで収まる
  // （組織の切り替えは列の中ではなく上の帯にあるので、その分だけ列が短い）。
  for (const viewport of [
    { width: 844, height: 390, overflows: true },
    { width: 1024, height: 600, overflows: true },
    { width: 1024, height: 680, overflows: true },
    { width: 1024, height: 768, overflows: false },
  ]) {
    test(`${viewport.width}×${viewport.height} の広げた列で、最後の項目とブランドの両方に届く`, async ({ page }) => {
      await page.setViewportSize(viewport);
      // 管理者がワークスペースを開くと、設定を含むすべての項目と切り替えが並ぶ。
      await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
      await expect(page.locator('.tree-row').first()).toBeVisible();
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 240);

      const inner = page.locator('.binding-inner');
      await expect(inner).toHaveCSS('overflow-y', 'auto');
      const last = page.locator('#app-nav .nav-item').last();
      // scrollIntoViewIfNeeded は下端への位置合わせの丸めで 1px 未満が欠けることがある。
      // 列の末尾まで送り、下の余白を含めて最後の項目全体に届くことを確かめる。
      await inner.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(last).toBeInViewport({ ratio: 1 });
      const overflow = await inner.evaluate((element) => element.scrollHeight - element.clientHeight);
      if (viewport.overflows) {
        expect(overflow).toBeGreaterThan(0);
        await expect.poll(() => inner.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      } else {
        expect(overflow).toBeLessThanOrEqual(0);
      }
      const href = await last.getAttribute('href');
      await last.click();
      await expect(page).toHaveURL(href!);

      // 下まで送った後もブランドへ戻れる。
      const brand = page.getByRole('link', { name: 'Banmen' });
      await brand.scrollIntoViewIfNeeded();
      await expect(brand).toBeInViewport({ ratio: 1 });
      await brand.click({ trial: true });

      // 組織の一覧は上の帯の下に浮かび、列を送った後に開いても切れない。
      await page.locator('.topbar .org-menu-button').click();
      const list = page.getByRole('list', { name: '入れる組織' });
      await expect(list).toBeVisible();
      // 表示直後は translate: 0 -4px から出る途中なので、動きが終わってから位置を測る。
      await expect(list).toHaveCSS('translate', /^0px(?: 0px)?$/);
      const barBottom = (await page.locator('.topbar').boundingBox())!;
      const listBox = (await list.boundingBox())!;
      expect(listBox.y).toBeGreaterThanOrEqual(barBottom.y + barBottom.height);
      expect(listBox.x + listBox.width).toBeLessThanOrEqual(viewport.width);
      const lastLink = list.getByRole('link').last();
      await lastLink.scrollIntoViewIfNeeded();
      await expect(lastLink).toBeInViewport({ ratio: 1 });
    });
  }
});

// 畳んだ列はホバーのできる端末だけに出る。高さの低い窓（細かいポインタ）で列を送った後も、
// 浮かせた項目名と開閉のボタンの札が、送った項目とボタンの横に揃う
test.describe('高さの低い窓の畳んだ左のメニュー', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  for (const viewport of [
    { width: 1280, height: 500 },
    { width: 1024, height: 420 },
  ]) {
    test(`${viewport.width}×${viewport.height} で列を送っても、項目名と開閉のボタンの札が揃う`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
      await expect(page.locator('.tree-row').first()).toBeVisible();
      await page.getByRole('button', { name: 'メニューを畳む' }).click();
      await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
      await expect(page.locator('.binding')).toHaveJSProperty('offsetWidth', 64);

      const inner = page.locator('.binding-inner');
      await expect(inner).toHaveCSS('overflow-y', 'auto');
      // この検査の前提: 列が画面より長く、中で送る必要がある
      expect(await inner.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);

      // 列を下まで送り、最後の項目に届いて、札が項目の右・縦の中央に揃う
      const last = page.locator('#app-nav .nav-item').last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport({ ratio: 1 });
      await expect.poll(() => inner.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await last.hover();
      const label = last.locator('.nav-item-label');
      await expect(label).toHaveCSS('opacity', '1');
      const itemBox = await last.boundingBox();
      const labelBox = await label.boundingBox();
      if (!itemBox || !labelBox) throw new Error('項目と札の位置が取れない');
      expect(labelBox.x).toBeCloseTo(itemBox.x + itemBox.width + 12, 0);
      expect(labelBox.y + labelBox.height / 2).toBeCloseTo(itemBox.y + itemBox.height / 2, 0);
      expect(labelBox.y).toBeGreaterThanOrEqual(0);
      expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(viewport.height);

      // 列を少しだけ送った状態で、開閉のボタンの札が、ボタンの右・縦の中央に揃う
      await inner.evaluate((element) => {
        element.scrollTop = 40;
      });
      const button = page.locator('.nav-toggle');
      await expect(button).toBeInViewport({ ratio: 1 });
      await button.hover();
      const tip = button.locator('.nav-tip');
      await expect(tip).toBeVisible();
      const buttonBox = await button.boundingBox();
      const tipBox = await tip.boundingBox();
      if (!buttonBox || !tipBox) throw new Error('ボタンと札の位置が取れない');
      expect(tipBox.x).toBeCloseTo(buttonBox.x + buttonBox.width + 12, 0);
      expect(tipBox.y + tipBox.height / 2).toBeCloseTo(buttonBox.y + buttonBox.height / 2, 0);

      // 組織の切り替えは上の帯にあり、一覧は帯の下に開いて画面の内側に収まる
      const org = page.locator('.topbar .org-menu-button');
      await org.click();
      const list = page.getByRole('list', { name: '入れる組織' });
      await expect(list).toBeVisible();
      await expect(list).toHaveCSS('translate', /^0px(?: 0px)?$/);
      const listBox = await list.boundingBox();
      const orgBox = await org.boundingBox();
      if (!listBox || !orgBox) throw new Error('組織の切り替えの位置が取れない');
      expect(listBox.y).toBeGreaterThanOrEqual(orgBox.y + orgBox.height);
      expect(listBox.x + listBox.width).toBeLessThanOrEqual(viewport.width);
    });
  }
});

// 左のメニューを送り切った後のホイールは、本文を送る（列の端で止めない）
test('左のメニューを送り切った後にホイールを回すと、本文が送れる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
  await expect(page.locator('.tree-row').first()).toBeVisible();
  const inner = page.locator('.binding-inner');
  await inner.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  // この検査の前提: 列が溢れ（送り切れる）、本文も画面より長い
  expect(await inner.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  await page.mouse.move(100, 150);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('畳んだ列のまま、全テーマでアクセシビリティの検査と CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  await expectNoA11yViolationsInThemes(page, 'today', exclusionsFor('today', isAxeCheck));
  expect(await collect()).toEqual([]);
});

test.describe('組織が2つの人（ミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('畳んだ列でも、上の帯の組織の切り替えから別の組織へ移れる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(today);
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    const org = page.locator('.topbar').getByRole('button', { name: '組織 あおば開発。組織を切り替える' });
    await expect(org).toBeVisible();
    // 畳んでも広げた列と同じ形で、名前を出したまま
    await expect(org.locator('b')).toHaveText('あおば開発');
    await expect(page.locator('.binding-head .org-menu')).toHaveCount(0);
    // 招待が無いときは印を出さない
    await expect(org.locator('.org-menu-invite')).toHaveCount(0);
    await org.click();
    const list = page.getByRole('list', { name: '入れる組織' });
    await expect(list).toBeVisible();
    await list.getByRole('link', { name: 'ひばり工房' }).click();
    await expect(page).toHaveURL(/\/hibari$/);
    await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
    await expect(page.locator('.topbar .org-menu-button > b')).toHaveText('ひばり工房');
  });

  test('畳んだ列で別の組織へ移っている間も、上の帯の名前の欄に「移っています」を出す', async ({ page }) => {
    await routeOperation(page, organizationInfo, { slug: 'hibari' }, async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await call.passThrough();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(today);
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    const org = page.locator('.topbar .org-menu-button');
    await org.click();
    await page.locator('.org-menu-list').getByRole('link', { name: 'ひばり工房' }).click();
    await expect(org.locator('b')).toHaveText('移っています');
    await expect(org).toHaveAccessibleName('組織 移っています。組織を切り替える');
    await expect(page).toHaveURL(/\/hibari$/);
    await expect(org).not.toHaveAttribute('data-moving', 'true');
  });

  test('バックログの画面でも、上の帯から開いた組織の一覧は本文の行に覆われない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.locator('.tree-row').first()).toBeVisible();
    await page.locator('.topbar .org-menu-button').click();
    for (const selector of ['.org-menu-list li:first-child a', '.org-menu-list li:last-child button'])
      expect(await frontmostAcross(page, selector)).toEqual([true, true, true]);
  });

  test('上の帯の組織の切り替えで、届いた招待があることが印と読み上げで分かり、畳んでも変わらない', async ({ page }) => {
    await mockOperation(page, myOrganizations, {
      organizations: [{ slug: 'aoba', name: 'あおば開発', kind: 'team' }],
      invitations: [{ organization_name: 'つばめ商会', slug: 'tsubame' }],
      suspended: [],
      operator: false,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(today);
    const org = page.locator('.topbar .org-menu-button');
    await expect(org).toHaveAccessibleName('組織 あおば開発 届いた招待あり。組織を切り替える');
    await expect(org.locator('.org-menu-invite')).toBeVisible();
    // 帯の高さを変えないよう、チップは見せず点で示す
    await expect(org.locator('.chip')).toBeHidden();
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    await expect(org).toHaveAccessibleName('組織 あおば開発 届いた招待あり。組織を切り替える');
    await expect(org.locator('.org-menu-invite')).toBeVisible();
  });
});

// 書体は @fontsource を自分の Worker から配る。外への通信が無く、本来の書体が読み込まれる
test('書体を自分のオリジンから読み込み、外へ通信しない', async ({ page, baseURL }) => {
  const collect = await watchViolations(page);
  const origins = new Set<string>();
  const fonts: string[] = [];
  page.on('request', (request) => {
    origins.add(new URL(request.url()).origin);
    if (/\.woff2?$/.test(new URL(request.url()).pathname)) fonts.push(request.url());
  });
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect([...origins]).toEqual([new URL(baseURL ?? '').origin]);
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((url) => url.includes('noto-sans-jp'))).toBe(true);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toHaveCSS(
    'font-family',
    /"Noto Sans JP"/,
  );
  expect(await page.evaluate(() => document.fonts.check('700 16px "Noto Sans JP"'))).toBe(true);
  expect(await collect()).toEqual([]);
});

// 覚えたテーマは、描く前に static/theme-init.js が html に当てる。シンプルの見た目を挟まない
test('覚えたテーマを、body ができる前に当てる', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.addInitScript(() => {
    localStorage.setItem('sg-theme', 'simple_dark');
    const seen: { theme: string | undefined; bodyExists: boolean }[] = [];
    (window as unknown as { __themeSeen: typeof seen }).__themeSeen = seen;
    new MutationObserver(() => {
      seen.push({ theme: document.documentElement.dataset.theme, bodyExists: document.body !== null });
      // 初期化のスクリプトは html の要素ができる前に動くので、document を subtree で見る
    }).observe(document, { attributes: true, attributeFilter: ['data-theme'], subtree: true });
  });
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();

  const seen = await page.evaluate(
    () => (window as unknown as { __themeSeen: { theme: string | undefined; bodyExists: boolean }[] }).__themeSeen,
  );
  expect(seen[0]).toEqual({ theme: 'simple_dark', bodyExists: false });
  expect(await collect()).toEqual([]);
});

// 消したテーマ（ネオン）を覚えていた人は、先当てで当てず、属性なし（シンプル（自動））で描く。画面が読み込まれた後に、自分のテーマ（simple）が当たる
test('前に覚えたネオンの値は先当てせず、シンプル（自動）で描く', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.addInitScript(() => {
    localStorage.setItem('sg-theme', 'modern');
    const seen: { theme: string | undefined; bodyExists: boolean }[] = [];
    (window as unknown as { __themeSeen: typeof seen }).__themeSeen = seen;
    new MutationObserver(() => {
      seen.push({ theme: document.documentElement.dataset.theme, bodyExists: document.body !== null });
    }).observe(document, { attributes: true, attributeFilter: ['data-theme'], subtree: true });
  });
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();

  const seen = await page.evaluate(
    () => (window as unknown as { __themeSeen: { theme: string | undefined; bodyExists: boolean }[] }).__themeSeen,
  );
  // body ができる前には何も当たらず、modern が当たったことも無い
  expect(seen.filter((entry) => !entry.bodyExists)).toEqual([]);
  expect(seen.filter((entry) => entry.theme === 'modern')).toEqual([]);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'simple');
  expect(await collect()).toEqual([]);
});

test('覚えた値が壊れていても、落ちずに描く', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sg-theme', 'retro'));
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  // 壊れた値は先当てで無視され、自分のテーマ（seed は選んでいない = simple）が当たる
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'simple');
});

// ダイアログとトーストの部品の確かめは、マイプロフィール（/aoba/me）の API トークンの節を使う（#686）。
// 取り消しの確認のダイアログ（seed のトークンの行から開く。やめるだけで、取り消さない）で開閉とフォーカスを、
// 発行の直後のダイアログ（発行の応答を差し替えるので、DB には何も書かない）でトーストを確かめる
const me = '/aoba/me';
const tokenSection = (page: Page) => page.getByRole('region', { name: 'API トークン', exact: true });
const revokeOpener = (page: Page) =>
  tokenSection(page)
    .getByRole('button', { name: /^API トークン「.+」を取り消す$/ })
    .first();
const revokeDialog = (page: Page) => page.getByRole('dialog', { name: /^API トークン「.+」を取り消しますか$/ });

async function openTokenSection(page: Page): Promise<void> {
  await page.goto(me);
  await expect(tokenSection(page).getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
}

// 発行の応答を差し替えて、値のダイアログを開く。トークンの値はコピーの確かめ用の偽の値で、DB には書かれない
async function openIssuedDialog(page: Page, token = `sgp_${'A'.repeat(43)}`, name = '確かめ用'): Promise<Locator> {
  await mockOperation(page, tokenCreate, {
    id: '019a0000-0000-7000-8000-00000000f686',
    name,
    scope: 'read',
    expires_at: '2099-01-01T00:00:00.000Z',
    token,
  });
  await openTokenSection(page);
  const section = tokenSection(page);
  await section.getByLabel('名前', { exact: true }).fill('確かめ用');
  await section.getByRole('button', { name: '発行する' }).click();
  const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('ダイアログとトースト（マイプロフィールの API トークンの節）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('ダイアログをキーボードだけで開閉でき、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
    const collect = await watchViolations(page);
    await openTokenSection(page);
    const opener = revokeOpener(page);
    const dialog = revokeDialog(page);
    await expectModalFocus(page, { opener, modal: dialog, press: 'Enter' });

    // 閉じるボタン（主ボタンの「やめる」）からも同じく戻る
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, opener);
    expect(await collect()).toEqual([]);
  });

  // Safari と Firefox はクリックしたボタンにフォーカスを移さない。mousedown の既定の動作を止めて同じ状態にし、
  // 画面が開く操作を起こしたボタン（show(trigger)）へフォーカスを戻すことを確かめる
  test('クリックでボタンにフォーカスが乗らなくても、閉じたら開いたボタンにフォーカスが戻る', async ({ page }) => {
    await openTokenSection(page);
    const opener = revokeOpener(page);
    await opener.evaluate((button) => button.addEventListener('mousedown', (event) => event.preventDefault()));
    await expectModalFocus(page, { opener, modal: revokeDialog(page) });
  });

  test('ダイアログの外側を押すと閉じ、中と外をまたいでドラッグしても閉じない', async ({ page }) => {
    await openTokenSection(page);
    const dialog = revokeDialog(page);
    const open = revokeOpener(page);

    await open.click();
    await expect(dialog).toBeVisible();
    const text = await dialog.getByText('取り消すと、このトークンはすぐ使えなくなります。').boundingBox();
    if (!text) throw new Error('ダイアログの本文の位置が取れない');
    // 中で押し始めて外で離す（文字の選択など）
    await page.mouse.move(text.x + 4, text.y + 4);
    await page.mouse.down();
    await page.mouse.move(4, 4);
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    // 外で押し始めて中で離す
    await page.mouse.move(4, 4);
    await page.mouse.down();
    await page.mouse.move(text.x + 4, text.y + 4);
    await page.mouse.up();
    await expect(dialog).toBeVisible();

    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, open);
  });
});

test.describe('トースト（マイプロフィールの API トークンの節。発行の応答を差し替える）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  const copyButton = (dialog: Locator) => dialog.getByRole('button', { name: 'コピーする' });

  // モーダルのダイアログが開くと、その外は inert になる。トーストはダイアログの中の領域に出る
  test('ダイアログを開いたままトーストを出すと、前面に見えて、読み上げの領域が inert でない', async ({ page }) => {
    const dialog = await openIssuedDialog(page);
    await copyButton(dialog).click();

    const toast = dialog.locator('.toast');
    await expect(toast).toHaveText('トークンの値をコピーしました');
    const state = await toast.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const region = element.closest('[aria-live]');
      return {
        onTop: hit !== null && element.contains(hit),
        region: region?.getAttribute('aria-live'),
        inert: element.closest('[inert]') !== null,
        regionDisplayed: region !== null && getComputedStyle(region).display !== 'none',
      };
    });
    expect(state).toEqual({ onTop: true, region: 'polite', inert: false, regionDisplayed: true });

    // 外側の領域（画面の最後に置いてある）は隠れ、同じ知らせが二重に読み上げられない。ダイアログを閉じると戻る。
    // 値のダイアログは Esc では閉じないので、閉じるボタンで閉じる
    const outer = page.locator('.toasts').last();
    await expect(outer).toHaveAttribute('hidden', '');
    await expect(page.locator('.toasts:visible .toast')).toHaveCount(1);

    await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
    await expect(dialog).toBeHidden();
    await expect(outer).not.toHaveAttribute('hidden', '');
  });

  // 成功と失敗で文言とアイコンを分ける
  test('「コピーする」は、成功と失敗を分けて文言とアイコンのトーストを出す', async ({ page }) => {
    const dialog = await openIssuedDialog(page);
    // ダイアログを開いている間は、トーストはダイアログの中の領域に出る
    const toasts = page.locator('.toasts:visible .toast');
    await copyButton(dialog).click();
    await expect(toasts).toHaveText('トークンの値をコピーしました');
    await expect(toasts.locator('use')).toHaveAttribute('href', '#i-check');

    // 書き込みを断られたときは、失敗のトースト
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    });
    await copyButton(dialog).click();
    // 最初のトーストは4秒で消えるので、数ではなく文言で絞る
    const failed = toasts.filter({ hasText: 'コピーできませんでした。値を選んで、手でコピーしてください' });
    await expect(failed).toHaveCount(1);
    await expect(failed.locator('use')).toHaveAttribute('href', '#i-alert');
  });

  test('トーストは数秒で消え、同時に出るのは3件まで', async ({ page }) => {
    const dialog = await openIssuedDialog(page);
    for (let i = 0; i < 5; i++) await copyButton(dialog).click();
    const toasts = page.locator('.toasts:visible .toast');
    await expect(toasts).toHaveCount(3);
    await expect(toasts).toHaveCount(0, { timeout: 8000 });
  });
});

// 同じ ID は同じ色。色相は style:--h（CSSOM）で渡すので CSP に止められない
test('アバターの色相が当たり、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.goto(today);
  // 今日やること（左のメニューと「自分の記録」の列）にも同じ名前のアバターが出るので、最初の1つを確かめる
  const avatar = page.getByRole('img', { name: 'ハルカ' }).first();
  await expect(avatar).toBeVisible();
  const style = await avatar.evaluate((element) => ({
    hue: getComputedStyle(element).getPropertyValue('--h').trim(),
    background: getComputedStyle(element).backgroundColor,
    styleAttribute: element.getAttribute('style'),
  }));
  expect(style.hue).toMatch(/^\d+$/);
  expect(Number(style.hue)).toBeLessThan(360);
  // 初期値の hsl(210 …) ではなく、計算した色相の色になっている
  expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(await collect()).toEqual([]);
});

test('画面の題名は「画面 - Banmen」で、メニューには画面のある項目だけが出る', async ({ page }) => {
  await page.goto(today);
  await expect(page).toHaveTitle('今日やること - Banmen');
  // 出る項目はすべて行き先を持つ（画面のある項目だけ）。今の画面は1つだけ
  await expect(page.locator('.nav-item')).not.toHaveCount(0);
  for (const item of await page.locator('.nav-item').all()) await expect(item).toHaveAttribute('href', /^\/aoba/);
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('.is-later')).toHaveCount(0);
  // 項目も切り替えも無いグループは、見出しごと出さない。
  const emptyGroups = await page
    .locator('.nav-group')
    .evaluateAll(
      (groups) => groups.filter((group) => !group.nextElementSibling?.matches('.nav-item, .ws-menu')).length,
    );
  expect(emptyGroups).toBe(0);
});

// 値は空白が無い長い文字列。狭い幅でも、画面とダイアログが横にはみ出さない
test('320px の幅で、長いトークンの値のダイアログが横にはみ出さない', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 320, height: 700 });
  // 空白の無い半角100文字の名前（API が通す上限）が、本文の「「…」の値です。」で折り返される
  const dialog = await openIssuedDialog(page, `sgp_${'A'.repeat(120)}`, 'A'.repeat(100));

  const overflow = () =>
    page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  const opened = await overflow();
  expect(opened.scroll).toBeLessThanOrEqual(opened.inner);
  await expect(dialog).toBeVisible();
  const dialogBox = await page.locator('.dialog-sheet:visible').evaluate((sheet) => ({
    sheetRight: sheet.getBoundingClientRect().right,
    contentRight: Math.max(
      ...[...sheet.querySelectorAll('.dialog-body *')].map((e) => e.getBoundingClientRect().right),
    ),
    inner: window.innerWidth,
  }));
  expect(dialogBox.sheetRight).toBeLessThanOrEqual(dialogBox.inner);
  expect(dialogBox.contentRight).toBeLessThanOrEqual(dialogBox.sheetRight);
});

// 経路に合わない深いパスも SPA の fallback で 200 のシェルを返し、404 は SvelteKit が画面の中で描く
test('経路に合わないパスも 200 でシェルを返し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto('/foo/bar/baz');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('/api/health は D1 に届いて 200 で版を返す', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', database: 'ok', credentialKeys: 'ok', version });
});

// 狭い幅では本文の見出しから始まり、短い本文の余りは sheet が受け取る。
for (const width of [390, 672]) {
  test(`幅 ${width}px で本文が短くても、上に旧メニューの空きが出ない`, async ({ page }) => {
    const height = 2000;
    await page.setViewportSize({ width, height });
    // ほかのテストが同じ D1 に足した行で本文が伸びないよう、既定のワークスペース1件だけを表示する。
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (organization) => ({
      ...organization,
      workspaces: organization.workspaces.filter(({ id }) => id === AOBA_WORKSPACE_ID),
    }));
    // 短い本文のレイアウトを確かめるため、共有 D1 によって長さが変わるほかの面も空にする。
    await mockOperation(page, todayOperation, { slug: 'aoba' }, { tasks: [], sprint_goals: [] });
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: null, steps: [] });
    await mockOperation(page, recentActivity, { slug: 'aoba' }, { entries: [], next: null });
    await page.goto(today);
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(pageHeight, '画面の内容が高さを超えたので、height を上げる').toBeLessThanOrEqual(height);
    await expect(page.locator('.binding')).toHaveCount(0);
    const sheet = await page.locator('.sheet').boundingBox();
    await expect(page.locator('.topbar')).toHaveCount(0);
    const heading = await page.locator('.page-title').boundingBox();
    if (!sheet || !heading) throw new Error('枠の要素の位置が取れない');
    expect(sheet.y).toBeCloseTo(0, 0);
    expect(heading.y).toBeGreaterThanOrEqual(16);
    expect(sheet.y + sheet.height).toBeCloseTo(height, 0);
    await expect(page.locator('.mobile-tabs')).toBeVisible();
  });
}

// build に埋めた kit.version.name は SvelteKit が書き出す version.json で見る
test('画面の build に埋めた版が API の版と同じ', async ({ request }) => {
  const res = await request.get('/_app/version.json');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ version });
});

// 版の箱の、画面の右端と下端からの距離。縦のスクロールバーを除いた幅で測る
async function versionBadgeInset(page: Page) {
  return page.locator('.app-version').evaluate((badge) => {
    const box = badge.getBoundingClientRect();
    return {
      right: document.documentElement.clientWidth - box.right,
      bottom: document.documentElement.clientHeight - box.bottom,
    };
  });
}

test('組織の画面の右下に、画面の build の版を出し、スクロールしても残る', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  const badge = page.locator('.app-version');
  await expect(badge).toHaveText(`版 ${version}`);
  // 空白の正規化に頼らず、読み上げ用のラベルと版の間の区切りも確かめる
  await expect(badge).toHaveJSProperty('textContent', `版 ${version}`);
  // 「版」は読み上げにだけ添え、目には版だけを出す
  await expect(badge.locator('.visually-hidden')).toHaveText('版');
  // 右下の角に置く（右は 16px の余白、下は 1px の余白）
  const atTop = await versionBadgeInset(page);
  expect(atTop.right).toBeCloseTo(16, 0);
  expect(atTop.bottom).toBeCloseTo(1, 0);
  // 画面に固定する。今日やることの seed は画面に収まるので、文書を伸ばしてから末尾まで送る
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    document.body.append(spacer);
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const scrolled = await versionBadgeInset(page);
  expect(scrolled.right).toBeCloseTo(16, 0);
  expect(scrolled.bottom).toBeCloseTo(1, 0);
  // 操作を受けない
  await expect(badge).toHaveCSS('pointer-events', 'none');
});

test('390px では、版を下のタブのすぐ上に置いて丸い角とホームバーから離し、長い版は省略して幅に収め、下に突き出る字を切らない', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(today);
  const tabs = page.locator('.mobile-tabs');
  await expect(tabs).toBeVisible();
  const badge = page.locator('.app-version');
  await expect(badge).toHaveText(`版 ${version}`);
  const tabsBox = await tabs.boundingBox();
  const badgeBox = await badge.boundingBox();
  if (!tabsBox || !badgeBox) throw new Error('下のタブか版の位置が取れない');
  // 下のタブの上端から 1px 上に置き、タブの上のトーストの余白（--space-4）に収める
  expect(tabsBox.y - (badgeBox.y + badgeBox.height)).toBeCloseTo(1, 0);
  expect(badgeBox.height).toBeLessThan(16);
  // 画面の下端（丸い角とホームバーのある帯）から離す
  expect((await versionBadgeInset(page)).bottom).toBeGreaterThan(16);

  // 版の長さは環境で変わる（手元は dev、CI は 40 桁の SHA）。どこでも省略を確かめるため、長い文字に差し替える。
  // overflow-x: clip の箱は scrollWidth を持たないので、文字の幅は Range で測る
  const long = await badge.evaluate((element) => {
    element.textContent = '0123456789abcdef'.repeat(5);
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      height: box.height,
      textWidth: range.getBoundingClientRect().width,
    };
  });
  expect(long.textWidth).toBeGreaterThan(long.right - long.left);
  expect(long.left).toBeGreaterThanOrEqual(0);
  expect(long.right).toBeLessThanOrEqual(390);
  // 折り返さずに1行のまま（--space-4 の 16px 未満）で、下のタブと重ならない
  expect(long.height).toBeLessThan(16);
  expect(long.top + long.height).toBeLessThanOrEqual(tabsBox.y);
  await expect(badge).toHaveCSS('white-space', 'nowrap');
  await expect(badge).toHaveCSS('text-overflow', 'ellipsis');

  // 手元の e2e の版（e2e-<時刻>）や preview のタグは、下に突き出る字を含む。字の上下の幅は行の高さより大きいので、縦は切らない
  await expect(badge).toHaveCSS('overflow-y', 'visible');
});

test('組織の枠の外（ログインの画面）にも版を出す', async ({ browser, baseURL }) => {
  // beforeEach のログインを持たない context で、ログインの画面を開く
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
    await expect(page.locator('.app-version')).toHaveText(`版 ${version}`);
    // 下のタブの無い狭い画面では、丸い角とホームバーから離すため下端から --space-4 上げる
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.mobile-tabs')).toHaveCount(0);
    expect((await versionBadgeInset(page)).bottom).toBeCloseTo(16, 0);
  } finally {
    await context.close();
  }
});

// 本文（.content）は幅の上限を持たない。広い画面でも左のメニューの右から画面の右の端まで広がる
// 4000px は、左のメニューを広げても畳んでも、2000px 台の上限を見逃さない幅
const WIDE_VIEWPORT = { width: 4000, height: 900 };
// 縦スクロールバーの幅の余裕
const SCROLLBAR_ALLOWANCE = 24;
// 欄の幅の上限（design/components.css の `.form` などの 56rem）
const FORM_MAX_PX = 56 * 16;

test('4000px の幅で、本文が画面の右の端まで広がり、畳んでも変わらない', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto(today);
  await page.evaluate(() => localStorage.removeItem('sg-nav-collapsed'));
  await page.reload();

  const content = page.locator('.content');
  await expect(content).toBeVisible();
  const open = await content.boundingBox();
  expect(open!.x + open!.width).toBeGreaterThan(WIDE_VIEWPORT.width - SCROLLBAR_ALLOWANCE);
  // 以前の上限（1320px）を超えている
  expect(open!.width).toBeGreaterThan(1320);

  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
  const folded = await content.boundingBox();
  expect(folded!.x + folded!.width).toBeGreaterThan(WIDE_VIEWPORT.width - SCROLLBAR_ALLOWANCE);
  expect(folded!.width).toBeGreaterThan(open!.width);
});

test('4000px の幅でも、組織の管理の欄は 56rem で止まり、表は止まらない', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto('/aoba/admin');

  // 表が出てから測る（読み込み前の空の箱は、上限が無くても幅が小さい）
  const table = page.locator('.setting-body > .table-wrap').first();
  await expect(table).toBeVisible();
  expect((await table.boundingBox())!.width).toBeGreaterThan(FORM_MAX_PX);

  const fieldWidths = await page
    .locator('.setting-body :is(.form, .form-row, .input-row, .field, .order-list)')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(fieldWidths.length).toBeGreaterThan(0);
  for (const width of fieldWidths) expect(width).toBeLessThanOrEqual(FORM_MAX_PX);
});

test('4000px の幅でも、マイプロフィールの API トークンの発行の欄は 56rem で止まる', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto('/aoba/me');

  const form = page.locator('form.form').first();
  await expect(form).toBeVisible();
  expect((await form.boundingBox())!.width).toBeLessThanOrEqual(FORM_MAX_PX);
});

test('4000px の幅でも、今日やることの画面に、アクセシビリティの違反が無い', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto(today);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'today', exclusionsFor('today', isAxeCheck));
});

// 枠の十字とパンくず（docs/design.md の「画面の枠の十字」）
test('広い幅では角のマスと上の帯の下の罫が同じ高さで通り、畳んでも崩れない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  await page.evaluate(() => localStorage.removeItem('sg-nav-collapsed'));
  await page.reload();
  await expect(page.locator('.topbar')).toBeVisible();

  const bottoms = () =>
    page.evaluate(() => ({
      head: document.querySelector('.binding-head')!.getBoundingClientRect().bottom,
      bar: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
      binding: document.querySelector('.binding')!.getBoundingClientRect().right,
      barLeft: document.querySelector('.topbar')!.getBoundingClientRect().left,
    }));
  const wide = await bottoms();
  expect(wide.head).toBe(wide.bar);
  // 上の帯は左のメニューの右の罫から始まる（縦の罫と交わる）
  expect(Math.abs(wide.barLeft - wide.binding)).toBeLessThanOrEqual(1);
  // 2本の横の罫が実際に引かれている（片方でも消えると十字が消える）
  await expect(page.locator('.binding-head')).not.toHaveCSS('border-bottom-width', '0px');
  await expect(page.locator('.topbar')).not.toHaveCSS('border-bottom-width', '0px');
  await expect(page.locator('.binding')).not.toHaveCSS('border-right-width', '0px');

  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
  const collapsed = await bottoms();
  expect(collapsed.head).toBe(collapsed.bar);
  expect(Math.abs(collapsed.barLeft - collapsed.binding)).toBeLessThanOrEqual(1);
  // 畳んでも、開閉のボタンは角のマスの下に押せる形で残る
  const toggle = await page.getByRole('button', { name: 'メニューを広げる' }).boundingBox();
  expect(toggle!.y).toBeGreaterThanOrEqual(collapsed.head);
});

// 角のマスはマーク（組織のホームへのリンク）と開閉のボタンだけ。組織の切り替えは上の帯の右、アカウントの左に置く（#1145、#1510）
test('角のマスにマークと開閉のボタンが並び、組織の切り替えは上の帯のアカウントの左にある', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${today}/me`);
  const head = page.locator('.binding-head');
  const bar = page.locator('.topbar');
  const brand = head.getByRole('link', { name: 'Banmen', exact: true });
  const toggle = head.getByRole('button', { name: 'メニューを畳む' });
  const org = bar.getByRole('button', { name: '組織 あおば開発。組織を切り替える' });
  const account = bar.locator('.account-menu-button');
  await expect(org).toBeVisible();
  await expect(org.locator('b')).toHaveText('あおば開発');
  await expect(head.locator('.org-menu')).toHaveCount(0);
  await expect(head.locator('.brand-name')).toHaveCount(0);
  await expect(page.locator('.binding-body .org-menu')).toHaveCount(0);

  // 角のマスは左からマーク、開閉の順で、どちらも角のマスの高さに収まる
  const headBox = (await head.boundingBox())!;
  const [brandBox, toggleBox] = await Promise.all(
    [brand, toggle].map(async (locator) => (await locator.boundingBox())!),
  );
  expect(brandBox.x + brandBox.width).toBeLessThanOrEqual(toggleBox.x);
  for (const box of [brandBox, toggleBox]) {
    expect(box.y).toBeGreaterThanOrEqual(headBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(headBox.y + headBox.height);
  }
  // 上の帯では、組織の切り替えがアカウントのすぐ左にあり、帯の高さに収まる
  const barBox = (await bar.boundingBox())!;
  const [orgBox, accountBox] = await Promise.all([org, account].map(async (locator) => (await locator.boundingBox())!));
  expect(orgBox.x + orgBox.width).toBeLessThanOrEqual(accountBox.x);
  expect(orgBox.x).toBeGreaterThan(barBox.x + barBox.width / 2);
  expect(orgBox.y).toBeGreaterThanOrEqual(barBox.y);
  expect(orgBox.y + orgBox.height).toBeLessThanOrEqual(barBox.y + barBox.height);
  const order = await bar.evaluate((element) =>
    [...element.querySelectorAll('.org-menu-button, .account-menu-button')].map((node) => node.className),
  );
  expect(order).toEqual(['org-menu-button', 'account-menu-button']);

  // マークは組織のホームへ戻る
  await brand.click();
  await expect(page).toHaveURL(/\/aoba$/);

  // 組織の名前を押すと、一覧が帯の下に、ボタンの右端に揃えて開き、画面の右からはみ出さない
  await org.click();
  const list = page.getByRole('list', { name: '入れる組織' });
  await expect(list).toBeVisible();
  await expect(list).toHaveCSS('translate', /^0px(?: 0px)?$/);
  const listBox = (await list.boundingBox())!;
  const openedOrg = (await org.boundingBox())!;
  expect(listBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
  expect(Math.abs(listBox.x + listBox.width - (openedOrg.x + openedOrg.width))).toBeLessThanOrEqual(1);
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(1280);
  await expect(list.getByRole('link', { name: 'あおば開発' })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
});

test('組織の一覧が読めず切り替えが無いときも、開閉のボタンは角のマスの右端に留まる', async ({ page }) => {
  await failOperation(page, myOrganizations, 503, 'unavailable');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  const head = page.locator('.binding-head');
  await expect(head.getByRole('link', { name: 'Banmen', exact: true })).toBeVisible();
  await expect(page.locator('.org-menu')).toHaveCount(0);
  const toggle = head.getByRole('button', { name: 'メニューを畳む' });
  const headBox = (await head.boundingBox())!;
  const padding = await head.evaluate((element) => parseFloat(getComputedStyle(element).paddingRight));
  const toggleBox = (await toggle.boundingBox())!;
  expect(Math.abs(toggleBox.x + toggleBox.width - (headBox.x + headBox.width - padding))).toBeLessThanOrEqual(1);
});

test('長い組織の名前でも、上の帯の切り替えは1行で省略し、十字の罫がずれない', async ({ page }) => {
  const long = 'とても長い名前のあおば開発の組織で上の帯の切り替えのボタンに収まらない名前';
  await mockOperation(page, myOrganizations, {
    organizations: [{ slug: 'aoba', name: long, kind: 'team' }],
    invitations: [],
    suspended: [],
    operator: false,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(today);
  const name = page.locator('.topbar .org-menu-button > b');
  await expect(name).toHaveText(long);
  await expect(name).toHaveCSS('text-overflow', 'ellipsis');
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // アカウントのボタンは押し出されず、帯の中に残る
  await expect(page.locator('.topbar .account-menu-button')).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  const bottoms = await page.evaluate(() => ({
    head: document.querySelector('.binding-head')!.getBoundingClientRect().bottom,
    bar: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
  }));
  expect(bottoms.head).toBe(bottoms.bar);
});

// 帯の幅が狭いときは、長い組織の名前を帯の幅の 1/4 で切り、検索の欄を左のメニューの下へ押し出さない（#1510）
test('761px で長い組織の名前でも、上の帯は1段に収まり、検索の欄とアカウントが見える', async ({ page }) => {
  const long = 'とても長い名前のあおば開発の組織で上の帯の切り替えのボタンに収まらない名前';
  await mockOperation(page, myOrganizations, {
    organizations: [{ slug: 'aoba', name: long, kind: 'team' }],
    invitations: [],
    suspended: [],
    operator: false,
  });
  await page.setViewportSize({ width: 761, height: 900 });
  await page.goto(today);
  const name = page.locator('.topbar .org-menu-button > b');
  await expect(name).toHaveText(long);
  for (const collapse of [false, true]) {
    if (collapse) {
      await page.getByRole('button', { name: 'メニューを畳む' }).click();
      await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
    }
    const layout = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        binding: box('.binding').right,
        bar: box('.topbar'),
        head: box('.binding-head').bottom,
        search: box('.topbar .nav-search'),
        org: box('.topbar .org-menu'),
        viewport: window.innerWidth,
        width: document.documentElement.scrollWidth,
      };
    });
    expect(layout.width).toBeLessThanOrEqual(761);
    // 検索の欄は左のメニューの右から始まる（左のメニューの下に隠れない）
    expect(layout.search.left).toBeGreaterThanOrEqual(layout.binding);
    // 組織の名前の幅は、画面の幅から左のメニュー（広げた列は 240px、畳んだ列は 64px）を引いた幅の 1/4 で止まる
    expect(layout.org.width).toBeCloseTo((layout.viewport - (collapse ? 64 : 240)) / 4, 0);
    // 帯は1段で、角のマスと罫の高さが揃う
    expect(layout.bar.bottom).toBe(layout.head);
    await expect(page.locator('.topbar .account-menu-button')).toBeInViewport();
  }
});

// 所属していない管理者の印も帯に並ぶとき、帯が詰まっても印を省略し、アカウントのボタンと検索の欄を潰さない（#1510）
test('761px と 800px で長い組織の名前と所属していない管理者の印があっても、アカウントのボタンと検索の欄が残る', async ({
  page,
}) => {
  await mockOperation(page, myOrganizations, {
    organizations: [
      {
        slug: 'aoba',
        name: 'とても長い名前のあおば開発の組織で上の帯の切り替えのボタンに収まらない名前',
        kind: 'team',
      },
    ],
    invitations: [],
    suspended: [],
    operator: false,
  });
  await page.setViewportSize({ width: 761, height: 900 });
  await page.goto(today);
  await expect(page.locator('.topbar .org-menu-button')).toBeVisible();
  // 印の出る画面（所属していないワークスペース）と同じ並びにするため、アカウントの前に同じ印を置く
  await page.locator('.topbar > .account-menu').evaluate((element) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = '所属せず管理者として開いています';
    element.before(chip);
  });
  for (const width of [761, 800]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        binding: box('.binding').right,
        search: box('.topbar .nav-search').left,
        account: box('.topbar .account-menu-button').width,
        chip: box('.topbar > .chip').width,
        width: document.documentElement.scrollWidth,
      };
    });
    expect(layout.width).toBeLessThanOrEqual(width);
    expect(layout.search).toBeGreaterThanOrEqual(layout.binding);
    expect(layout.account).toBeGreaterThanOrEqual(44);
    // 印は 4rem（64px）より縮めない
    expect(layout.chip).toBeGreaterThanOrEqual(64);
  }
  // 761px では印の文字が収まらず、右を切るのではなく省略記号で省略する
  await page.setViewportSize({ width: 761, height: 900 });
  const chip = page.locator('.topbar > .chip');
  await expect(chip).toHaveCSS('text-overflow', 'ellipsis');
  await expect(chip).toHaveCSS('display', 'block');
  await expect(chip).toHaveCSS('white-space', 'nowrap');
  expect(await chip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // 1行のまま（帯の高さを変えない）
  const bottoms = await page.evaluate(() => ({
    head: document.querySelector('.binding-head')!.getBoundingClientRect().bottom,
    bar: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
  }));
  expect(bottoms.bar).toBe(bottoms.head);
});

test('組織の画面のパンくずは組織と画面で、ワークスペースを出さない', async ({ page }) => {
  await page.goto(today);
  const crumbs = page.getByRole('navigation', { name: 'パンくず' });
  await expect(crumbs.getByRole('link', { name: 'あおば開発' })).toHaveAttribute('href', '/aoba');
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('今日やること');
  await expect(crumbs.getByRole('link')).toHaveCount(1);
});

test('ワークスペースの画面のパンくずから、組織とワークスペースの最初の画面へ移れる', async ({ page }) => {
  await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}/board`);
  const crumbs = page.getByRole('navigation', { name: 'パンくず' });
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('ボード');
  await expect(crumbs.getByRole('link')).toHaveCount(2);
  await expect(crumbs.getByRole('link').nth(1)).toHaveAttribute('href', `/aoba/w/${AOBA_WORKSPACE_ID}`);
  await crumbs.getByRole('link').nth(1).click();
  await expect(page).toHaveURL(`/aoba/w/${AOBA_WORKSPACE_ID}`);
  await crumbs.getByRole('link', { name: 'あおば開発' }).click();
  await expect(page).toHaveURL('/aoba');
});

// パンくずは上の帯ではなく、本文の見出しのすぐ上に出す（#1509）。ワークスペースの名前の小見出しは 761px 以上では出さない
test('広い幅のパンくずは上の帯の外で、見出しのすぐ上に出し、ワークスペースの名前の小見出しを重ねない', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of [`/aoba/w/${AOBA_WORKSPACE_ID}`, `/aoba/w/${AOBA_WORKSPACE_ID}/members`]) {
    await page.goto(path);
    const crumbs = page.getByRole('navigation', { name: 'パンくず' });
    await expect(crumbs).toBeVisible();
    await expect(page.locator('.topbar .breadcrumb')).toHaveCount(0);
    await expect(crumbs.getByRole('link', { name: '受託開発チーム' })).toBeVisible();
    const heading = page.locator('.page-head').first();
    await expect(heading).toBeVisible();
    // 位置は帯（.sheet-crumbs）で測る。nav は帯の高さ 24px の中で上下の中央に置かれる
    const [bar, crumb, head] = await Promise.all(
      [page.locator('.topbar'), page.locator('.sheet-crumbs'), heading].map(
        async (locator) => (await locator.boundingBox())!,
      ),
    );
    // 上の帯の下、見出しの上に並び、見出しとの間は本文の上の余白（--space-2 の 8px）だけ
    expect(crumb.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    expect(head.y - (crumb.y + crumb.height)).toBeCloseTo(8, 0);
    // パンくずの左端は見出しの左端と揃う
    expect(Math.abs((await crumbs.boundingBox())!.x - head.x)).toBeLessThanOrEqual(1);
    // ワークスペースの名前の小見出しは見えない（題名には残す）
    await expect(page.locator('.page-head .page-eyebrow:visible')).toHaveCount(0);
    await expect(page).toHaveTitle(/・受託開発チーム - Banmen$/);
  }
});

test('ワークスペースの名前の小見出しは 760px 以下だけに出し、ワークスペースの Wiki も同じにする', async ({ page }) => {
  for (const path of [`/aoba/w/${AOBA_WORKSPACE_ID}/members`, `/aoba/w/${AOBA_WORKSPACE_ID}/wiki`]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    const eyebrow = page.locator('.page-head .page-eyebrow');
    // 760px 以下はパンくずが無いので、小見出しが今のワークスペースを示す
    await expect(eyebrow).toBeVisible();
    await expect(eyebrow).toHaveText('受託開発チーム');
    await expect(page.getByRole('navigation', { name: 'パンくず' })).toHaveCount(0);
    // 761px 以上はパンくずが同じ名前を出すので、小見出しを隠す
    await page.setViewportSize({ width: 761, height: 844 });
    await expect(
      page.getByRole('navigation', { name: 'パンくず' }).getByRole('link', { name: '受託開発チーム', exact: true }),
    ).toBeVisible();
    await expect(eyebrow).toBeHidden();
  }
});

test('タスクの詳細の画面でもパンくずが見出しの上に出て、最後のワークスペースから戻れる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}/tasks/019a0000-0000-7000-8000-000000000801`);
  await expect(page.locator('.drawer.is-page')).toHaveAttribute('aria-busy', 'false');
  const crumbs = page.getByRole('navigation', { name: 'パンくず' });
  const workspace = crumbs.getByRole('link', { name: '受託開発チーム' });
  await expect(workspace).toHaveAttribute('aria-current', 'page');
  const crumb = (await crumbs.boundingBox())!;
  const title = (await page.locator('.drawer.is-page').boundingBox())!;
  expect(crumb.y + crumb.height).toBeLessThanOrEqual(title.y);
  await workspace.click();
  await expect(page).toHaveURL(`/aoba/w/${AOBA_WORKSPACE_ID}`);
});

test('長い組織とワークスペースの名前でも、パンくずは1行に収め、全文を title と読み上げに残す', async ({ page }) => {
  const organization = 'こもれび工房の空想都市と星空観測の道具をつくる共同研究開発チームの組織';
  const workspace = 'とても長い名前のワークスペースで本文の幅に収まらないかもしれない名前の例';
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    organization: { ...output.organization, name: organization },
  }));
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({ ...output, name: workspace }));
  for (const width of [800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}/members`);
    const crumbs = page.getByRole('navigation', { name: 'パンくず' });
    await expect(crumbs.getByRole('link', { name: workspace })).toHaveAttribute('title', workspace);
    await expect(crumbs.getByRole('link', { name: organization })).toHaveAttribute('title', organization);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('メンバー');
    // 項目は同じ行に並び（縦に積まない）、横にはみ出さない
    const tops = await crumbs
      .locator('li')
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

// 760px 以下ではパンくずを出さない。大きな見出しと入口、長い名前の折り返しは
// layout-narrow-breadcrumb.test.ts で各テーマと境界幅を検査する。

test.describe('指で押す画面の 761px 以上', () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 800 } });
  test('押せる大きさの要素が入っても、角のマスと上の帯の罫が同じ高さに通る', async ({ page }) => {
    await page.goto(today);
    await expect(page.locator('.topbar')).toBeVisible();
    const bottoms = await page.evaluate(() => ({
      head: document.querySelector('.binding-head')!.getBoundingClientRect().bottom,
      bar: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
    }));
    expect(bottoms.head).toBe(bottoms.bar);
    // 上の帯の組織の切り替えも、指で押せる 44px の高さにする（#1510）
    const org = await page.locator('.topbar .org-menu-button').boundingBox();
    expect(org!.height).toBeGreaterThanOrEqual(44);
  });
});

test('761px の幅で表示名が長くても、上の帯が横にはみ出さず罫の高さが保たれる', async ({ page }) => {
  await page.setViewportSize({ width: 761, height: 800 });
  await page.goto(today);
  await expect(page.locator('.topbar')).toBeVisible();
  // 上の帯にパンくずは無く、幅が足りない分は検索の欄とアカウントの表示名が縮んで受け持つ
  await expect(page.locator('.topbar .breadcrumb')).toHaveCount(0);
  await page.locator('.account-menu-button .me').evaluate((element) => {
    element.insertBefore(
      document.createTextNode('Komorebi0123456789012345678901234567890123456789'),
      element.firstChild,
    );
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.topbar .nav-search')).toBeInViewport({ ratio: 1 });
  const bottoms = await page.evaluate(() => ({
    head: document.querySelector('.binding-head')!.getBoundingClientRect().bottom,
    bar: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
  }));
  expect(bottoms.head).toBe(bottoms.bar);
});
