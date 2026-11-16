import { workspaceInfo, workspaceSprintNamingUpdate } from '../src/shared/operations/workspace/index.ts';
import { sprintCreate, sprintList } from '../src/shared/operations/sprint/index.ts';
import { failOperation } from './operations.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn } from './helpers.ts';

test('設定で命名ルールと次の番号を決め、名前を自動入力して2本作る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '命名ルールの画面');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  await page.goto(`/aoba/w/${workspaceId}/settings`);
  const setting = page.getByRole('region', { name: 'スプリントの命名ルール', exact: true });
  const template = setting.getByLabel('命名ルール', { exact: true });
  await expect(setting).toContainText('{w}');
  await template.fill('{unknown}');
  await setting.getByRole('button', { name: '保存する' }).click();
  await expect(setting.locator('.field-error')).toContainText('使えない変数');
  await template.fill('スプリント{n}');
  await setting.getByLabel('次の番号', { exact: true }).fill('0');
  await expect(setting.getByText(/^次の名前の例/)).toHaveCount(0);
  await expect(setting.getByRole('status').filter({ hasText: '次の名前の例' })).toHaveCount(0);
  await setting.getByRole('button', { name: '保存する' }).click();
  await expect(setting.getByLabel('次の番号', { exact: true })).toBeFocused();
  await expect(template).toHaveAttribute('aria-invalid', 'false');
  await expect(setting.getByLabel('次の番号', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await setting.getByLabel('次の番号', { exact: true }).fill('12');
  await expect(setting).toContainText('スプリント12');

  const savedResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/aoba/${workspaceSprintNamingUpdate.name}`),
  );
  await setting.getByRole('button', { name: '保存する' }).click();
  expect((await savedResponse).status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'スプリントの命名ルールを保存しました。' })).toBeVisible();
  await page.goto(`/aoba/w/${workspaceId}/plan`);
  const dialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  for (const number of [12, 13]) {
    await page.getByRole('button', { name: 'スプリントを作る', exact: true }).click();
    await expect(dialog.getByLabel('名前（任意）')).toHaveValue(`スプリント${number}`);
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.lane-title', { hasText: `スプリント${number}` })).toBeVisible();
  }
  await page.goto(`/aoba/w/${workspaceId}/settings`);
  await expect(setting.getByLabel('次の番号', { exact: true })).toHaveValue('14');
  await template.fill('スプリント{yyyy}-{mm}-{w}w');
  const secondSavedResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/aoba/${workspaceSprintNamingUpdate.name}`),
  );
  await setting.getByRole('button', { name: '保存する' }).click();
  expect((await secondSavedResponse).status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'スプリントの命名ルールを保存しました。' })).toBeVisible();
  await page.goto(`/aoba/w/${workspaceId}/plan`);
  await page.getByRole('button', { name: 'スプリントを作る', exact: true }).click();
  await dialog.getByLabel('開始日', { exact: true }).fill('2026-01-05');
  await expect(dialog.getByLabel('名前（任意）')).toHaveValue('スプリント2026-01-1w');
  await dialog.getByLabel('開始日', { exact: true }).fill('2026-01-12');
  await expect(dialog.getByLabel('名前（任意）')).toHaveValue('スプリント2026-01-2w');
  await dialog.getByLabel('名前（任意）').fill('人が決めた名前');
  await dialog.getByLabel('開始日', { exact: true }).fill('2026-01-19');
  await expect(dialog.getByLabel('名前（任意）')).toHaveValue('人が決めた名前');
});

test('メンバーには命名ルールを直す欄が出ない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401/settings');
  await expect(page.getByText('この画面には入れません', { exact: true })).toBeVisible();
  await expect(page.getByLabel('命名ルール', { exact: true })).toHaveCount(0);
});

test('命名ルールと完成の定義の書きかけは1つの確認で捨てる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '設定の書きかけ');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  await page.goto(`/aoba/w/${workspaceId}/settings`);
  await page.getByLabel('命名ルール', { exact: true }).fill('次{n}');
  await page.getByRole('region', { name: '完成の定義', exact: true }).getByRole('textbox').fill('全件を確認');
  await page.getByRole('link', { name: '計画', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '書き続ける', exact: true }).click();
  await expect(page.getByLabel('命名ルール', { exact: true })).toHaveValue('次{n}');
  await page.getByRole('link', { name: '計画', exact: true }).click();
  await confirmation.getByRole('button', { name: '捨てる', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/aoba/w/${workspaceId}/plan$`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('命名の読み取り失敗はほかの設定を隠さず、再試行できる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '命名節の読み取り失敗');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  const restore = await failOperation(page, sprintList, { slug: 'aoba' }, 500, 'internal');
  await page.goto(`/aoba/w/${workspaceId}/settings`);
  await expect(page.getByRole('region', { name: '完成の定義', exact: true })).toBeVisible();
  const setting = page.getByRole('region', { name: 'スプリントの命名ルール', exact: true });
  await expect(setting.getByRole('alert')).toContainText('読み込めませんでした');
  await restore();
  await setting.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(setting.getByLabel('命名ルール', { exact: true })).toBeVisible();
});

test('ルールだけの保存は別タブの作成で進んだ番号を巻き戻さず、再読取失敗では保存しない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '次の番号を保つ');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  await page.goto(`/aoba/w/${workspaceId}/settings`);
  const setting = page.getByRole('region', { name: 'スプリントの命名ルール', exact: true });
  await setting.getByLabel('命名ルール', { exact: true }).fill('次{n}');
  const headers = { Origin: new URL(baseURL!).origin };
  const created = await page.request.post(`/api/aoba/${sprintCreate.name}`, {
    headers,
    data: { workspace_id: workspaceId, start_on: '2099-01-01', length: 14, name: '別の画面で作成' },
  });
  expect(created.status()).toBe(200);
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/api/aoba/${workspaceSprintNamingUpdate.name}`),
  );
  await setting.getByRole('button', { name: '保存する' }).click();
  expect((await saved).status()).toBe(200);
  await expect(setting.getByLabel('次の番号', { exact: true })).toHaveValue('2');
  await setting.getByRole('button', { name: '保存する' }).click();
  await expect(setting.getByRole('status')).toHaveText('保存した内容から変わっていません。');
  await setting.getByLabel('命名ルール', { exact: true }).fill('書きかけ{n}');
  const restore = await failOperation(page, workspaceInfo, { slug: 'aoba' }, 500, 'internal');
  await setting.getByRole('button', { name: '保存する' }).click();
  await expect(setting.getByRole('alert')).toContainText('保存できませんでした');
  await expect(setting.getByLabel('命名ルール', { exact: true })).toHaveValue('書きかけ{n}');
  await restore();
});
