// #267: seed の所属は変えず、作ったワークスペースの離脱を本物の API で確認する。
// 参加者（討伐隊）は外した（#1434）。抜けても、エピックの画面は開け、作成者は離脱済みで残る
import { operationPath } from '../src/shared/operations/define.ts';
import { epicCreate } from '../src/shared/operations/epic/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn } from './helpers.ts';

test('メンバーの画面から抜けても、エピックの画面は開け、作成者の表示は離脱済みで残る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const name = `離脱後のエピック確認${Date.now()}`;
  await createWorkspace(page, name);
  const workspacePath = new URL(page.url()).pathname;
  const workspaceId = workspacePath.split('/').at(-1)!;
  const headers = { origin: new URL(page.url()).origin };
  const created = await page.request.post(operationPath(epicCreate, 'aoba'), {
    headers,
    data: epicCreate.input.parse({ workspace_id: workspaceId, title: '離脱後の作成者を確認する' }),
  });
  expect(created.ok()).toBe(true);
  const { epic } = epicCreate.output.parse(await created.json());

  const epicPath = `${workspacePath}/epics/${epic.id}`;
  await page.goto(epicPath);
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dd').nth(0)).toContainText('ミナト');
  await expect(request.locator('dd').nth(0)).not.toContainText('離脱済み');

  await page.goto(`${workspacePath}/members`);
  await page.getByRole('button', { name: `${name}から抜ける` }).click();
  await page
    .getByRole('dialog', { name: `${name}から抜けますか` })
    .getByRole('button', { name: '抜ける' })
    .click();
  await expect(page).toHaveURL(/\/aoba$/);
  // 管理者は所属を終えたワークスペースも読める。
  await page.goto(epicPath);
  await expect(page.getByRole('heading', { level: 1, name: '離脱後の作成者を確認する' })).toBeVisible();
  await expect(request.locator('dd').nth(0)).toContainText('ミナト（離脱済み）');
  await expect(page.getByRole('region', { name: '参加者' })).toHaveCount(0);
});
