import type { Page } from '@playwright/test';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const workspaceId = '019a0000-0000-7000-8000-000000000401';
const backlog = `/aoba/w/${workspaceId}`;
const toggleOf = (page: Page) => page.locator('#app-nav .nav-group-toggle');
const listOf = (page: Page) => page.getByRole('list', { name: '所属するワークスペース' });

async function oneWorkspace(page: Page) {
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
    ...body,
    workspaces: body.workspaces.filter((workspace) => workspace.id === workspaceId),
  }));
}

test('今日やることから一般のメンバーが一覧で所属先へ移り、戻っても対象を保つ', async ({ page, context, baseURL }) => {
  // seed を変えず、この回だけの移動先を作る。一般のユーザーのハルカを最初のリーダーにする。
  await signIn(context, baseURL, 'admin');
  const name = `架空の切り替え先 ${test.info().repeatEachIndex}-${test.info().retry}`;
  await page.goto('/aoba/admin');
  await page.getByRole('button', { name: 'ワークスペースを作る' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'ワークスペースを作る' });
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByRole('combobox').selectOption({ label: 'ハルカ' });
  await dialog.getByLabel('名前').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await page.getByRole('dialog', { name: 'ワークスペースを作りました' }).getByRole('button', { name: '開く' }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
  const target = new URL(page.url()).pathname;

  // 所属していない管理者には、今のものは押せない現在地の行、リンクは所属先だけ。
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(listOf(page).locator('.nav-item.is-current')).toHaveText(name);
  await expect(listOf(page).locator('.nav-item.is-current')).toHaveAttribute('aria-current', 'page');
  await expect(listOf(page).getByRole('link', { name, exact: true })).toHaveCount(0);
  // 所属していない管理者が開いているものは、一覧の先頭に出る
  await expect(listOf(page).locator('li').first()).toHaveText(name);

  await page.goto('/aoba/admin');
  const row = page.getByRole('region', { name: 'ワークスペース', exact: true }).locator('tbody tr', { hasText: name });
  await row.getByRole('button', { name: `「${name}」を終了する` }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: `「${name}」を終了する` })
    .click();
  await expect(row.locator('.chip')).toHaveText(/^終了 /);

  await signIn(context, baseURL, 'member');
  const collect = await watchViolations(page);
  await page.goto('/aoba');
  await expect(page.getByRole('heading', { level: 1, name: '今日やること', exact: true })).toBeVisible();
  const todayTasks = await page.locator('.content .entry-title').allTextContents();
  const nav = page.locator('#app-nav');
  await expect(nav.getByRole('link', { name: '今日やること', exact: true })).toHaveAttribute('aria-current', 'page');
  // ワークスペースの機能は、ワークスペースの画面のタブにあり、組織の画面の左のメニューにもタブにも出さない（#1514）
  for (const label of ['バックログ', 'ボード', '計画', 'Wiki', 'メンバー', '設定'])
    await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  await expect(page.locator('.route-tabs')).toHaveCount(0);
  await expect(page.locator('.nav-item', { hasText: '組織の管理' })).toHaveCount(0);
  const current = listOf(page).getByRole('link', { name: '受託開発チーム', exact: true });
  await expect(current).not.toHaveAttribute('aria-current');
  await expect(current.locator('use')).toHaveAttribute('href', '#i-check');
  const destination = listOf(page).getByRole('link', { name, exact: true });
  await expect(destination).toHaveAttribute('href', target);
  await destination.click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
  // 移っても一覧は開いたまま。開いているワークスペースの行に印と現在地が付く
  await expect(listOf(page)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ', exact: true })).toBeVisible();
  await expect(page.getByText(/に終了しました。読み取り専用です。/).first()).toBeVisible();
  await expect(listOf(page).getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: '今日やること', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba$/);
  await expect(listOf(page).getByRole('link', { name, exact: true })).not.toHaveAttribute('aria-current');
  await expect(listOf(page).getByRole('link', { name, exact: true }).locator('use')).toHaveAttribute(
    'href',
    '#i-check',
  );
  await expect(page.locator('.content .entry-title')).toHaveText(todayTasks);
  // 戻った対象のワークスペースへ一覧から移ると、タブはその対象を指し、リーダーには設定も出す（#1514）
  await listOf(page).getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
  const tabs = page.getByRole('navigation', { name: 'ワークスペースの画面' });
  await expect(tabs.getByRole('link', { name: '設定', exact: true })).toHaveAttribute('href', `${target}/settings`);
  await expect(tabs.getByRole('link', { name: 'メンバー', exact: true })).toHaveAttribute('href', `${target}/members`);
  await tabs.getByRole('link', { name: 'メンバー', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${target}/members$`));
  expect(await collect()).toEqual([]);
});

test('見出しを押すと一覧が畳まれ、もう一度押すと開き、読み直しても畳んだ状態を保つ', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.goto(backlog);
  const toggle = toggleOf(page);
  await expect(toggle).toHaveAccessibleName(/ワークスペース/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-controls', 'app-nav-workspaces');
  await expect(listOf(page)).toBeVisible();
  // キーボードでも開閉できる。押してもフォーカスは見出しのボタンに残る
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(listOf(page)).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.reload();
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(listOf(page)).toBeHidden();
  await toggleOf(page).click();
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(listOf(page)).toBeVisible();
  await page.reload();
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(listOf(page)).toBeVisible();
});

test('所属が複数でも一覧は通常のリンクで、矢印キーを押しただけでは移らない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
    ...body,
    workspaces: [
      ...body.workspaces.filter((workspace) => workspace.id === workspaceId),
      {
        id: '019a0000-0000-7000-8000-000000009001',
        name: '架空の切り替え先 A',
        role: 'member' as const,
        closed_at: null,
      },
    ],
  }));
  await page.goto(backlog);
  await expect(listOf(page).getByRole('link')).toHaveCount(2);
  const first = listOf(page).getByRole('link').first();
  await first.focus();
  for (const key of ['ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(key);
    await expect(first).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`${backlog}$`));
  }
  await page.keyboard.press('Tab');
  await expect(listOf(page).getByRole('link').nth(1)).toBeFocused();
  await expect(listOf(page).getByRole('link').nth(1)).toHaveAttribute(
    'href',
    '/aoba/w/019a0000-0000-7000-8000-000000009001',
  );
});

test.describe('所属が1つの一般のメンバー', () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    await oneWorkspace(page);
  });

  test('所属が1つでも見出しと一覧を出し、開いているものに印と現在地が付く。切り替えのボタンは無い', async ({
    page,
  }) => {
    await page.goto(backlog);
    await expect(toggleOf(page)).toBeVisible();
    await expect(page.locator('.ws-menu, .ws-menu-button')).toHaveCount(0);
    const current = listOf(page).getByRole('link');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAttribute('href', backlog);
    await expect(current.locator('use')).toHaveAttribute('href', '#i-check');
  });

  test('今日やることにも一覧があり、左のメニューを閉じると隠れ、760px以下では浮きメニューから移れる（#1102）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/aoba');
    await expect(listOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'メニューを閉じる' }).click();
    await expect(listOf(page)).toBeHidden();
    await page.getByRole('button', { name: 'メニューを開く' }).click();
    for (const width of [760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
      // 一覧は浮きメニューの面の中に出る。切り替えのドロップダウンは無い
      await expect(page.locator('#app-nav .ws-menu-button')).toHaveCount(0);
      const list = listOf(page);
      await expect(list).toBeVisible();
      const link = list.getByRole('link').first();
      expect(
        await link.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      ).toBe(true);
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await toggleOf(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await expect(page.locator('.mobile-menu')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
    await listOf(page).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`${backlog}$`));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/aoba');
    await expect(listOf(page)).toBeVisible();
  });

  test('今日やることからキーボードで畳み、Tab で行へ進んで対象のバックログを開ける', async ({ page }) => {
    await page.goto('/aoba');
    const toggle = toggleOf(page);
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(listOf(page)).toBeHidden();
    await page.keyboard.press('Space');
    await expect(listOf(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(listOf(page).getByRole('link')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${backlog}$`));
  });
});

test('所属0件の今日やることには見出しも一覧も行き先のないメニューも出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({ ...body, workspaces: [] }));
  await page.goto('/aoba');
  await expect(page.getByRole('heading', { level: 1, name: '今日やること', exact: true })).toBeVisible();
  await expect(toggleOf(page)).toHaveCount(0);
  await expect(listOf(page)).toHaveCount(0);
  await expect(page.locator('#app-nav a[href*="/w/"]')).toHaveCount(0);
});

for (const width of [1280, 1024]) {
  test(`${width}px で長い名前は行の中で省略され、全文を title と読み上げで読め、横にはみ出さない`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    const names = Array.from({ length: 30 }, (_, i) => ({
      id: `019a0000-0000-7000-8000-${String(8000 + i).padStart(12, '0')}`,
      name: `架空の開発チーム ${i}・長いワークスペースの名前は行に収まらないと省略して表示する`,
      role: 'member' as const,
      closed_at: null,
    }));
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
      ...body,
      workspaces: [...body.workspaces.filter((workspace) => workspace.id === workspaceId), ...names],
    }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(backlog);
    const list = listOf(page);
    await expect(list.getByRole('link')).toHaveCount(31);
    const link = list.getByRole('link', { name: names[7]!.name, exact: true });
    await expect(link).toHaveAttribute('title', names[7]!.name);
    const label = link.locator('.nav-item-label');
    expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await label.evaluate((element) => getComputedStyle(element).textOverflow)).toBe('ellipsis');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const nav = page.locator('#app-nav');
    expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
