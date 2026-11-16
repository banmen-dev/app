// 命名ルールのAPIを、実際の計画画面からのスプリント作成と組み合わせて確かめる。
// 名前の自動入力の画面は別タスク。このテストでは確定する名前を人が入力する。
import { workspaceInfo, workspaceSprintNamingUpdate } from '../src/shared/operations/workspace/index.ts';
import { sprintList } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn } from './helpers.ts';

test('命名ルールと次の番号をAPIで変え、計画からの作成だけで番号が進む', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '命名ルールの確認');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  const headers = { Origin: new URL(baseURL!).origin };
  const read = async () => {
    const res = await page.request.post(`/api/aoba/${sprintList.name}`, {
      headers,
      data: { workspace_id: workspaceId },
    });
    expect(res.status()).toBe(200);
    return sprintList.output.parse(await res.json());
  };
  expect((await read()).defaults).toMatchObject({ sprint_name_template: null, sprint_number_next: 1 });
  const updated = await page.request.post(`/api/aoba/${workspaceSprintNamingUpdate.name}`, {
    headers,
    data: { workspace_id: workspaceId, sprint_name_template: 'スプリント{n}', sprint_number_next: 12 },
  });
  expect(updated.status()).toBe(200);
  expect(workspaceSprintNamingUpdate.output.parse(await updated.json())).toEqual({
    sprint_name_template: 'スプリント{n}',
    sprint_number_next: 12,
  });
  const info = await page.request.post(`/api/aoba/${workspaceInfo.name}`, {
    headers,
    data: { workspace_id: workspaceId },
  });
  expect(info.status()).toBe(200);
  expect(workspaceInfo.output.parse(await info.json())).toMatchObject({
    sprint_name_template: 'スプリント{n}',
    sprint_number_next: 12,
  });

  await page.goto(`/aoba/w/${workspaceId}/plan`);
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  await dialog.getByLabel('名前（任意）').fill('人が確定した名前');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.lane-title', { hasText: '人が確定した名前' })).toBeVisible();
  const after = await read();
  expect(after.defaults).toMatchObject({ sprint_name_template: 'スプリント{n}', sprint_number_next: 13 });
  expect(after.sprints[0]?.name).toBe('人が確定した名前');

  const invalid = await page.request.post(`/api/aoba/${workspaceSprintNamingUpdate.name}`, {
    headers,
    data: { workspace_id: workspaceId, sprint_name_template: '{unknown}', sprint_number_next: 1 },
  });
  expect(invalid.status()).toBe(400);
  expect((await read()).defaults.sprint_number_next).toBe(13);
});
