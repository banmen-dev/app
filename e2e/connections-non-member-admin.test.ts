// 所属していない管理者の seed の例（#1640）。あおば開発の問い合わせ対応チームは、リーダーがハルカだけで、管理者のミナトは所属しない。
// seed の行は読むだけで変えない（止める操作は応答を差し替える `e2e/connections.test.ts` と `test/connection-manage.test.ts` が確かめる）
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

const SUPPORT_ID = '019a0000-0000-7000-8000-000000000407';
const SUPPORT = `/aoba/w/${SUPPORT_ID}`;

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('所属していない管理者が開いたワークスペースは、一覧の先頭に現在地の行として出る', async ({ page }) => {
  await page.goto(SUPPORT);
  const list = page.getByRole('list', { name: '所属するワークスペース' });
  await expect(list.locator('li').first()).toHaveText('問い合わせ対応チーム');
  const current = list.locator('.nav-item.is-current');
  await expect(current).toHaveText('問い合わせ対応チーム');
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(list.getByRole('link', { name: '問い合わせ対応チーム', exact: true })).toHaveCount(0);
  await expect(list.getByRole('link', { name: '受託開発チーム', exact: true })).toBeVisible();
});

test('所属していない管理者には、ハルカの接続に止めると削除が出て、範囲と編集は出ない', async ({ page }) => {
  await page.goto(`${SUPPORT}/connections`);
  await expect(page.getByRole('heading', { level: 1, name: '接続' })).toBeVisible();
  const items = page.getByRole('list', { name: '接続の一覧' }).getByRole('listitem');
  await expect(items).toHaveCount(1);
  const item = items.filter({ hasText: 'ハルカの GitHub' });
  await expect(item.getByRole('button', { name: '止める' })).toBeEnabled();
  await expect(item.getByRole('button', { name: '削除' })).toBeEnabled();
  await expect(item.getByRole('button', { name: '編集', exact: true })).toHaveCount(0);
  await expect(item.getByRole('button', { name: '今すぐ同期' })).toHaveCount(0);
});
