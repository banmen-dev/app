import { randomUUID } from 'node:crypto';
import { operationPath, type OutputOf } from '../src/shared/operations/define.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { workspaceWikiCreate } from '../src/shared/operations/wiki/index.ts';
import { workspaceCreate, workspaceInfo } from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

test('管理者が設定で終了済みワークスペースを削除し、組織ホームに戻る', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL がありません');
  await signIn(context, baseURL, 'admin');
  const slug = 'aoba';
  const headers = { Origin: new URL(baseURL).origin };
  const name = `削除確認ワークスペース ${randomUUID().slice(0, 8)}`;
  const info = await page.request.post(operationPath(organizationInfo, slug), { headers, data: {} });
  expect(info.ok()).toBe(true);
  const { me } = (await info.json()) as OutputOf<typeof organizationInfo>;
  const created = await page.request.post(operationPath(workspaceCreate, slug), {
    headers,
    data: { name, timezone: 'Asia/Tokyo', leader_user_id: me.id },
  });
  expect(created.ok()).toBe(true);
  const { workspace_id: workspaceId } = (await created.json()) as OutputOf<typeof workspaceCreate>;
  const wiki = await page.request.post(operationPath(workspaceWikiCreate, slug), {
    headers,
    data: { workspace_id: workspaceId, title: '削除確認のノート', body_md: '残る Wiki の本文です。' },
  });
  expect(wiki.ok()).toBe(true);

  const workspacePath = `/${slug}/w/${workspaceId}`;
  const settingsPath = `${workspacePath}/settings`;
  const section = page.getByRole('region', { name: 'ワークスペースの削除' });
  await page.setViewportSize({ width: 390, height: 844 });
  const removeDisabledResponse = await rewriteOperation(page, workspaceInfo, { slug }, (output) => ({
    ...output,
    workspace_delete_enabled: false,
  }));
  await page.goto(settingsPath);
  await expect(page.getByRole('heading', { level: 1, name: '設定', exact: true })).toBeVisible();
  await expect(section).toHaveCount(0);
  await removeDisabledResponse();
  await page.reload();
  await expect(section).toContainText('先にこのワークスペースを終了してください');
  const open = section.getByRole('button', { name: '削除する' });
  await expect(open).toHaveCount(0);

  await section.getByRole('link', { name: '利用状態へ移動' }).click();
  const close = page.getByRole('button', { name: `「${name}」を終了する` });
  await expect(close).toBeFocused();
  await close.click();
  const closeDialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
  await closeDialog.getByRole('button', { name: `「${name}」を終了する` }).click();
  await expect(closeDialog).toBeHidden();
  await expect(page.getByRole('button', { name: `「${name}」を再開する` })).toBeVisible();
  await open.click();
  const dialog = page.getByRole('dialog', { name: `「${name}」を削除しますか？` });
  await expect(dialog).toContainText('削除は取り消せません');
  await expect(dialog).toContainText('添付ファイルと Wiki は引き続き容量に含まれます');
  const confirmation = dialog.getByRole('textbox', { name: 'ワークスペース名' });
  const submit = dialog.getByRole('button', { name: '削除する' });
  const mismatch = dialog.getByText('入力がワークスペース名と一致していません。', { exact: true });
  await expect(confirmation).toBeFocused();
  await expect(submit).toBeDisabled();
  await confirmation.fill(name.slice(0, 2));
  await expect(mismatch).toBeHidden();
  await expect(submit).toBeDisabled();
  await confirmation.blur();
  await expect(mismatch).toBeVisible();
  await confirmation.focus();
  await expect(mismatch).toBeHidden();
  await confirmation.fill(`${name}違い`);
  await expect(submit).toBeDisabled();
  await expect(mismatch).toBeVisible();
  await confirmation.dispatchEvent('compositionstart');
  await expect(mismatch).toBeHidden();
  await confirmation.fill(name);
  await expect(submit).toBeDisabled();
  await confirmation.press('Enter');
  await expect(dialog).toBeVisible();
  await confirmation.dispatchEvent('compositionend');
  await expect(submit).toBeEnabled();
  await dialog.getByRole('button', { name: 'やめる' }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  await open.click();
  await expect(confirmation).toHaveValue('');
  await confirmation.fill(name);
  await submit.click();
  await expect(page).toHaveURL(/\/aoba$/);
  await expect(
    page.locator('.toasts:visible .toast').filter({ hasText: 'ワークスペースを削除しました' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);

  await page.goto(settingsPath);
  await expect(page.getByRole('heading', { name: 'ワークスペースが見つかりません' })).toBeVisible();
  await page.goto(`/${slug}/admin`);
  const list = page.getByRole('region', { name: 'ワークスペース', exact: true });
  await expect(list.getByRole('rowgroup').last()).not.toContainText(name);
  const history = page.getByRole('region', { name: '変更の履歴' });
  const deletion = history.getByRole('row').filter({ hasText: `ワークスペース「${name}」を削除しました` });
  await expect(deletion).toHaveCount(1);
  await expect(deletion).toContainText(me.name);
  const storage = page.getByRole('region', { name: '添付ファイルと Wiki の容量' });
  const retained = storage.getByRole('row').filter({ hasText: name });
  await expect(retained).toContainText('削除済み');
  await expect(retained).toContainText(/[1-9]\d*\s*B/);
  await expect(retained.getByRole('link')).toHaveCount(0);
});
