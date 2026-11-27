// ワークスペースの画面のタブ（#1514、#1516）。ワークスペースのどの画面でも本文の見出しの上に機能のタブが並び、
// 左のメニューにも浮きメニューにもワークスペースの機能の項目を出さない。幅が足りなければ入りきらないタブを「その他 <件数>」にまとめる。
// axe はワークスペースの画面ごとの検査（backlog、members など。タブを含む画面全体）が2つのテーマで受け持つ
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, findA11yViolations, signIn, watchViolations } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const TASK = '019a0000-0000-7000-8000-000000000801';
const ALL = ['受信箱', 'バックログ', 'ボード', '計画', 'Wiki', '接続', 'メンバー', '設定'];

const tabsOf = (page: Page) => page.getByRole('navigation', { name: 'ワークスペースの画面' });

test.describe('リーダー（あおば開発のミナト）', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('見出しの上にタブが並び、押すとその画面へ移って今の画面のタブに印が付く', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto(WORKSPACE);
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    const tabs = tabsOf(page);
    await expect(tabs.getByRole('link')).toHaveText(ALL);
    await expect(tabs.locator('[aria-current="page"]')).toHaveText('バックログ');
    // パンくずの下、見出しの上。本文（main）の外に置く
    const crumbs = (await page.locator('.sheet-crumbs').boundingBox())!;
    const bar = (await tabs.boundingBox())!;
    const heading = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(crumbs.y + crumbs.height);
    expect(heading.y).toBeGreaterThan(bar.y + bar.height);
    await expect(page.locator('main .route-tabs')).toHaveCount(0);

    for (const [name, path, title] of [
      ['ボード', '/board', null],
      ['計画', '/plan', '計画'],
      ['メンバー', '/members', 'メンバー'],
      ['設定', '/settings', '設定'],
      ['受信箱', '/inbox', '受信箱'],
    ] as const) {
      await tabs.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${WORKSPACE}${path}$`));
      if (title) await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(tabs.locator('[aria-current="page"]')).toHaveText(name);
      await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
    }
    expect(await collect()).toEqual([]);
  });

  test('左のメニューにはワークスペースの機能の項目と「記録」「管理」の見出しを出さない', async ({ page }) => {
    await page.goto(WORKSPACE);
    const nav = page.locator('#app-nav');
    await expect(nav.locator('.nav-group-toggle')).toBeVisible();
    for (const name of ALL) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(nav.locator('.nav-group-label', { hasText: /^(記録|管理)$/ })).toHaveCount(0);
    // 組織の画面にはタブを出さない
    await page.goto('/aoba');
    await expect(page.locator('.route-tabs')).toHaveCount(0);
  });

  test('タスクの詳細ではどのタブも選ばず、Wiki では Wiki を選ぶ', async ({ page }) => {
    await page.goto(`${WORKSPACE}/tasks/${TASK}`);
    await expect(page.getByRole('heading', { level: 1, name: 'ポイント付与のバッチを作る' })).toBeVisible();
    await expect(tabsOf(page).getByRole('link')).toHaveCount(ALL.length);
    await expect(tabsOf(page).locator('[aria-current]')).toHaveCount(0);
    await page.goto(`${WORKSPACE}/wiki`);
    await expect(tabsOf(page).locator('[aria-current="page"]')).toHaveText('Wiki');
  });

  test('画面の検索、g b と g s、パンくずの画面名は今までどおり', async ({ page }) => {
    await page.goto(`${WORKSPACE}/members`);
    await expect(page.getByRole('heading', { level: 1, name: 'メンバー' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'パンくず' }).locator('[aria-current="page"]')).toHaveText(
      'メンバー',
    );
    const search = page.getByRole('combobox', { name: '画面とタスクを探す' });
    await search.fill('ボード');
    await expect(page.getByRole('option', { name: /ボード/ }).first()).toBeVisible();
    await search.fill('メンバー');
    await expect(page.getByRole('option', { name: /メンバー/ }).first()).toBeVisible();
    await search.fill('');
    await search.blur();
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE}/board$`));
    await expect(tabsOf(page).locator('[aria-current="page"]')).toHaveText('ボード');
    await page.keyboard.press('g');
    await page.keyboard.press('b');
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE}$`));
    await expect(tabsOf(page).locator('[aria-current="page"]')).toHaveText('バックログ');
  });
});

test.describe('左のメニューを広げた 800px', () => {
  test.use({ viewport: { width: 800, height: 900 } });
  test('761px 以上でも幅が足りなければ同じ形でまとめ、今の画面のタブが入ったときはボタンに印を付ける', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(`${WORKSPACE}/settings`);
    await expect(page.getByRole('heading', { level: 1, name: '設定' })).toBeVisible();
    const more = tabsOf(page).getByRole('button', { name: /^その他/ });
    // この検査の前提: 800px では全部が入らず、末尾の設定がまとめられる
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('data-current', 'true');
    // 帯は横に送られず、ページも溢れない
    expect(await page.locator('.route-tabs').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await more.click();
    await expect(
      page.getByRole('list', { name: 'ワークスペースのその他の画面' }).locator('[aria-current="page"]'),
    ).toHaveText('設定');
    // 左端の画面へ移ると、ボタンの印は外れる
    await page.keyboard.press('Escape');
    await tabsOf(page).getByRole('link', { name: '受信箱', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE}/inbox$`));
    await expect(more).not.toHaveAttribute('data-current', 'true');
  });
});

test.describe('一般のメンバー（あおば開発のハルカ）', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test('設定のタブを出さない', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    await page.goto(WORKSPACE);
    await expect(tabsOf(page).getByRole('link')).toHaveText(ALL.filter((name) => name !== '設定'));
  });
});

test.describe('指で押す 1024px の端末', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  test('タブは押せる範囲 44px を持つ', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(WORKSPACE);
    const tabs = tabsOf(page).getByRole('link');
    const more = tabsOf(page).getByRole('button', { name: /^その他/ });
    await expect(tabs.first()).toBeVisible();
    for (const tab of await tabs.all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (await more.isVisible()) expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('760px 以下と「その他」', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  const more = (page: Page) => page.getByRole('button', { name: /^その他/ });
  const moreList = (page: Page) => page.getByRole('list', { name: 'ワークスペースのその他の画面' });

  test('見出しの上にタブと「その他」が出て、浮きメニューには機能の項目が無い', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(WORKSPACE);
    const heading = page.getByRole('heading', { level: 1, name: 'バックログ' });
    await expect(heading).toBeVisible();
    await expect(tabsOf(page)).toBeVisible();
    await expect(more(page)).toBeVisible();
    // 帯は見出しの上にあり、横に溢れない
    const tabsBox = (await tabsOf(page).boundingBox())!;
    expect(tabsBox.y + tabsBox.height).toBeLessThanOrEqual((await heading.boundingBox())!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // どの機能へも、列のタブか「その他」の一覧から移れる
    const shown = await tabsOf(page).getByRole('link').count();
    await more(page).click();
    await expect(more(page)).toHaveAttribute('aria-expanded', 'true');
    expect(shown + (await moreList(page).getByRole('link').count())).toBe(ALL.length);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
    const menu = page.locator('.mobile-menu');
    for (const name of ALL.filter((label) => label !== 'バックログ' && label !== 'ボード'))
      await expect(menu.getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(menu.locator('.nav-group-label', { hasText: '管理' })).toHaveCount(0);
    // 下のタブバーは今のまま
    await page.keyboard.press('Escape');
    await expect(page.locator('.mobile-tabs')).toBeVisible();
  });

  test('「その他」の中のメンバーへ移ると、ボタンに印が付き、一覧でその項目が今の画面と分かる', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(WORKSPACE);
    await more(page).click();
    await moreList(page).getByRole('link', { name: 'メンバー', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE}/members$`));
    await expect(moreList(page)).toBeHidden();
    await expect(more(page)).toHaveAttribute('data-current', 'true');
    await expect(more(page)).toHaveAccessibleName(/開いている画面を含む/);
    await more(page).click();
    await expect(moreList(page).getByRole('link', { name: 'メンバー', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('一覧は Esc と外を押すと閉じ、フォーカスがボタンに戻る', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(WORKSPACE);
    await more(page).click();
    await moreList(page).getByRole('link').first().focus();
    await page.keyboard.press('Escape');
    await expect(moreList(page)).toBeHidden();
    await expect(more(page)).toBeFocused();
    await more(page).click();
    await expect(moreList(page)).toBeVisible();
    await page.getByRole('heading', { level: 1, name: 'バックログ' }).click();
    await expect(moreList(page)).toBeHidden();
  });

  test('幅を広げると、まとめていたタブが列に戻る', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(WORKSPACE);
    await expect(more(page)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(more(page)).toHaveCount(0);
    for (const name of ALL) await expect(tabsOf(page).getByRole('link', { name, exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(more(page)).toBeVisible();
  });

  test('4つの見た目で axe と押せる範囲 44px が、390px と 1280px で通る', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(WORKSPACE);
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(tabsOf(page)).toBeVisible();
        if (width === 390) {
          await more(page).click();
          await expect(moreList(page)).toBeVisible();
        }
        expect(await findA11yViolations(page), `${theme} ${width}px`).toEqual([]);
        const targets = [
          ...(await tabsOf(page).getByRole('link').all()),
          ...(await tabsOf(page).getByRole('button').all()),
        ];
        for (const target of targets) {
          if (await target.isVisible()) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        if (width === 390) await page.keyboard.press('Escape');
      }
    }
  });
});
