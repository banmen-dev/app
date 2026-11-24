// ワークスペースの画面のタブ（#1514）。761px 以上で、ワークスペースのどの画面でもパンくずの下に機能のタブが並び、
// 左のメニューにはワークスペースの機能の項目を出さない。760px 以下は今までどおり浮きメニューの項目で移る。
// axe はワークスペースの画面ごとの検査（backlog、members など。タブを含む画面全体）が2つのテーマで受け持つ
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';

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
    await expect(nav.locator('.ws-menu-button')).toBeVisible();
    for (const name of ALL) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(nav.locator('.nav-group-label')).not.toContainText(['記録']);
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
    await expect(tabs).toHaveCount(ALL.length);
    for (const tab of await tabs.all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('760px 以下', () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test('タブを出さず、浮きメニューにワークスペースの項目を今までどおり出す', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(WORKSPACE);
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(page.locator('.route-tabs')).toHaveCount(0);
    await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
    const menu = page.locator('.mobile-menu');
    for (const name of ALL) await expect(menu.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(menu.locator('.nav-group-label', { hasText: '管理' })).toBeVisible();
  });
});
