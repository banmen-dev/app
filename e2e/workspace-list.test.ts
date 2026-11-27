import type { Page } from '@playwright/test';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, findA11yViolations, signIn, watchViolations } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const workspaceId = '019a0000-0000-7000-8000-000000000401';
const backlog = `/aoba/w/${workspaceId}`;
const toggleOf = (page: Page) => page.locator('#app-nav .nav-group-toggle');
const listOf = (page: Page) => page.getByRole('list', { name: 'ワークスペースの一覧' });

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
  // 押せない行は、省略せず折り返して全文を見せる（フォーカスが来ないので、title だけでは読めない）
  await expect(listOf(page).locator('.nav-item.is-current .nav-item-label')).toHaveCSS('white-space', 'normal');

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
    // 切り替えのドロップダウンは無い。ポップアップを開くボタンも、開閉を持つボタンは見出しの1つだけ
    await expect(page.locator('#app-nav button[aria-haspopup]')).toHaveCount(0);
    await expect(page.locator('#app-nav button[aria-expanded]')).toHaveCount(1);
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
      await expect(page.locator('#app-nav button[aria-haspopup]')).toHaveCount(0);
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

test('開いた一覧と畳んだ一覧が、ライトとダークで axe の違反を持たない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto(backlog);
  await expect(listOf(page)).toBeVisible();
  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    for (const collapsed of [false, true]) {
      const toggle = toggleOf(page);
      if ((await toggle.getAttribute('aria-expanded')) === String(collapsed)) await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', String(!collapsed));
      expect(await findA11yViolations(page, '#app-nav'), `${theme} ${collapsed ? '畳んだ' : '開いた'}状態`).toEqual([]);
    }
    await toggleOf(page).click();
  }
});

const manyNames = Array.from({ length: 30 }, (_, i) => ({
  id: `019a0000-0000-7000-8000-${String(8000 + i).padStart(12, '0')}`,
  name: `架空の開発チーム ${i}・長いワークスペースの名前は行に収まらないと省略して表示する`,
  role: 'member' as const,
  closed_at: null,
}));

test('キーボードで長い名前の行に当てても、下の行は動かず、全文の吹き出しが出る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
    ...body,
    workspaces: [...body.workspaces.filter((workspace) => workspace.id === workspaceId), ...manyNames],
  }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(backlog);
  const links = listOf(page).getByRole('link');
  await expect(links).toHaveCount(31);
  const target = listOf(page).getByRole('link', { name: manyNames[7]!.name, exact: true });
  const next = listOf(page).getByRole('link', { name: manyNames[8]!.name, exact: true });
  const before = (await next.boundingBox())!.y;
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  expect((await next.boundingBox())!.y).toBe(before);
  // 行は省略したまま。全文は行の下の吹き出し（li の ::after）に出し、読み上げの名前には含めない
  await expect(target.locator('.nav-item-label')).toHaveCSS('white-space', 'nowrap');
  const bubble = await target.evaluate((element) => {
    const style = getComputedStyle(element.parentElement!, '::after');
    return { content: style.content, position: style.position };
  });
  expect(bubble.position).toBe('absolute');
  expect(bubble.content).toContain(manyNames[7]!.name);
  await expect(target).toHaveAccessibleName(manyNames[7]!.name);
});

test('別のタブで一覧を畳むと、このタブで一覧の中にあったフォーカスは見出しのボタンへ移る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(backlog);
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'true');
  await listOf(page).getByRole('link').first().focus();
  await expect(listOf(page).getByRole('link').first()).toBeFocused();

  const other = await context.newPage();
  await other.setViewportSize({ width: 1280, height: 900 });
  await other.goto(backlog);
  await toggleOf(other).click();
  await expect(toggleOf(other)).toHaveAttribute('aria-expanded', 'false');

  await expect(listOf(page)).toBeHidden();
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(toggleOf(page)).toBeFocused();
  // 一覧の外にあったフォーカスは動かさない
  await toggleOf(other).click();
  await expect(listOf(page)).toBeVisible();
  await page.getByRole('link', { name: '今日やること', exact: true }).first().focus();
  await toggleOf(other).click();
  await expect(listOf(page)).toBeHidden();
  await expect(page.getByRole('link', { name: '今日やること', exact: true }).first()).toBeFocused();
  await other.close();
});

test.describe('760px 以下の浮きメニュー', () => {
  test.use({ viewport: { width: 390, height: 700 } });

  const openMenu = async (page: Page) => {
    await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
    const dialog = page.locator('.mobile-menu');
    await expect(dialog).toBeVisible();
    return dialog;
  };

  test('現在地は機能の項目の1つだけで、一覧の行は見えない文言で開いているものを伝える', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await page.goto(backlog);
    const dialog = await openMenu(page);
    await expect(dialog.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(dialog.locator('.nav-ws-list [aria-current]')).toHaveCount(0);
    await expect(dialog.locator('.nav-ws-list .nav-item').filter({ has: page.locator('.ico') })).toContainText(
      '（開いている）',
    );
  });

  test('一覧の高さは 40dvh までで、超えたら一覧の中でスクロールし、下の機能の項目に届く', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
      ...body,
      workspaces: [...body.workspaces.filter((workspace) => workspace.id === workspaceId), ...manyNames],
    }));
    await page.goto(backlog);
    const dialog = await openMenu(page);
    const list = dialog.getByRole('list', { name: 'ワークスペースの一覧' });
    const box = (await list.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(700 * 0.4 + 1);
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    // 長い名前は浮きメニューでは折り返して全文が見え、吹き出しは出さない
    const label = list.getByRole('link', { name: manyNames[3]!.name, exact: true }).locator('.nav-item-label');
    await label.scrollIntoViewIfNeeded();
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // 一覧の下の機能の項目へ、メニューのスクロールで届く
    const members = dialog.getByRole('link', { name: 'メンバー', exact: true });
    await members.scrollIntoViewIfNeeded();
    await expect(members).toBeInViewport();
  });

  test('開いた、畳んだ、長い名前の一覧が、ライトとダークで axe の違反を持たず、押せる範囲が 44px 以上で、テーマが戻らない', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => ({
      ...body,
      workspaces: [...body.workspaces.filter((workspace) => workspace.id === workspaceId), ...manyNames.slice(0, 5)],
    }));
    await page.goto(backlog);
    const dialog = await openMenu(page);
    const toggle = dialog.locator('.nav-group-toggle');
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      for (const collapsed of [false, true]) {
        if ((await toggle.getAttribute('aria-expanded')) === String(collapsed)) await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', String(!collapsed));
        const list = dialog.getByRole('list', { name: 'ワークスペースの一覧' });
        if (collapsed) await expect(list).toBeHidden();
        else {
          await expect(list).toBeVisible();
          for (const link of await list.getByRole('link').all())
            expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(
          await findA11yViolations(page, '.mobile-menu'),
          `${theme} ${collapsed ? '畳んだ' : '開いた'}状態`,
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      }
      await toggle.click();
    }
  });
});
