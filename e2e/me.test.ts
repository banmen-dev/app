// マイプロフィール、アカウントのメニュー、メンバーの一覧、ワークスペースのホーム（バックログ）に、経験値とレベルが出ないこと（#1432）。
// seed のセッション（seed/sessions.ts）の Cookie で開く。経験値の明細は seed に無く、画面も API も読まない
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

// 経験値とレベルの部品（紋章、レベルの面、ゲージ、明細の値、チーム全体の合計）の印
const GAME_PARTS = '.emblem, .level, .gauge, .xp-num, .xp-delta, .team-xp, .breakdown';

test.describe('経験値とレベルを出さない', () => {
  test('マイプロフィールはテーマと API トークンの節を出し、レベルの面と経験値の明細を出さず、経験値の操作を呼ばない', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    const collect = await watchViolations(page);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    await page.goto('/aoba');
    await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
    await page.locator('.account-menu-list').getByRole('link', { name: 'マイプロフィール', exact: true }).click();
    await expect(page).toHaveURL(/\/aoba\/me$/);
    await expect(page.getByRole('heading', { level: 1, name: 'マイプロフィール' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('ミナト');
    await expect(page).toHaveTitle('マイプロフィール - Banmen');
    await expect(page.getByRole('heading', { level: 2, name: 'テーマ' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'API トークン' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'レベル', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '経験値の明細' })).toHaveCount(0);
    await expect(page.locator(GAME_PARTS)).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/レベル|LV|XP|経験値/);
    expect(requests.some((path) => path.includes('/experience-'))).toBe(false);
    expect(await collect()).toEqual([]);
  });

  test('アカウントのメニューは名前の横に紋章を出さず、読み上げの名前にレベルの数字を含めない', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto('/aoba');
    const button = page.locator('.account-menu-button');
    await expect(button).toHaveAccessibleName('ミ ミナト 管理者。アカウントのメニュー');
    await expect(button.locator('.emblem')).toHaveCount(0);
  });

  test('メンバーの一覧は名前の横に紋章を出さない', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}/members`);
    await expect(page.getByRole('heading', { level: 1, name: 'メンバー' })).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(page.locator('.emblem')).toHaveCount(0);
  });

  test('ワークスペースのホームは見出しにチーム全体の経験値を出さず、経験値の操作を呼ばない', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(page.locator('.tree')).toBeVisible();
    await expect(page.locator('.team-xp')).toHaveCount(0);
    await expect(page.locator('.page-head')).not.toContainText(/レベル|LV|XP|経験値/);
    expect(requests.some((path) => path.includes('/experience-'))).toBe(false);
  });

  test('320px の幅で、区切りの無い長い名前のマイプロフィールもはみ出さない', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.setViewportSize({ width: 320, height: 800 });
    const longName = 'ミナト'.repeat(15);
    await rewriteOperation(page, organizationInfo, { slug: 'hibari' }, (json) => {
      json.me.name = longName;
      return json;
    });
    await page.goto('/hibari/me');
    await expect(page.locator('.page-eyebrow')).toHaveText(longName);
    await expect(page.getByRole('heading', { level: 2, name: 'API トークン' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
