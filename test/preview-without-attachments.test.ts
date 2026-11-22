import { describe, expect, test } from 'vitest';
import { attachmentDelete, attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { me } from '../src/shared/operations/session/index.ts';
import { taskUpdate } from '../src/shared/operations/task/index.ts';
import { download, storedFile } from './attachment-download-helpers.ts';
import { app, attachmentRows, upload } from './attachment-helpers.ts';
import { createTask } from './factories.ts';
import { avatarRows, deleteAvatar, getAvatar, uploadAvatar, uploadedUrl } from './me-avatar-helpers.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv } from './operations/world.ts';

// Workers の型は本番の設定から生成される。このテストだけで、実際のプレビューと同様に R2 バインディングを外す。
const previewEnv = {
  ...testEnv,
  PUBLIC_ORIGIN: 'https://pr-1406-banmen-preview.banmen-preview.workers.dev',
  PREVIEW_WITHOUT_ATTACHMENTS: '1',
  ATTACHMENTS: undefined,
} as unknown as Env;

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(await errorCodeOf(response)).toBe('unavailable');
}

describe('R2 を持たない共有プレビュー', () => {
  test('ヘルスチェックとセッションを使う通常の API が応答する', async () => {
    const target = await createTarget();
    const health = await app.request('/api/health', {}, previewEnv);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', database: 'ok' });
    const session = await post(app, me, { token: target.member.token, env: previewEnv });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ account_id: target.member.accountId });
  });

  test('添付のアップロードは利用不可を返し、D1 に書かない', async () => {
    const target = await createTarget();
    await expectUnavailable(await upload(target, { env: previewEnv }));
    expect(await attachmentRows(target)).toEqual([]);
    expect((await upload(target)).status).toBe(200);
  });

  test('本文だけは保存でき、添付 ID を含む更新は利用不可を返す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const { row } = await storedFile(target);
    const save = (body: { body_md: string; attachment_ids?: string[] }) =>
      post(app, taskUpdate, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, task_id: task.id, ...body },
        env: previewEnv,
      });

    expect((await save({ body_md: '本文だけ' })).status).toBe(200);
    expect((await save({ body_md: '添付なし', attachment_ids: [] })).status).toBe(200);
    await expectUnavailable(await save({ body_md: '添付あり', attachment_ids: [row.id] }));
    expect((await attachmentRows(target)).find((file) => file.id === row.id)?.task_id).toBeNull();
    const current = await save({ body_md: '添付なし' });
    expect(await current.json()).toMatchObject({ task: { body_md: '添付なし' } });
  });

  test('添付のダウンロードと削除は利用不可を返し、既存の行を保つ', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const { row } = await storedFile(target, {
      row: { task_id: task.id, attached_at: '2026-11-03T00:00:00.000Z' },
    });
    await expectUnavailable(await download(target, row.id, { env: previewEnv }));
    await expectUnavailable(
      await post(app, attachmentDelete, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, task_id: task.id, attachment_id: row.id },
        env: previewEnv,
      }),
    );
    expect((await attachmentRows(target)).map((file) => file.id)).toEqual([row.id]);
  });

  test('プロフィール画像のアップロード・配信・削除は利用不可を返し、既存の行を保つ', async () => {
    const target = await createTarget();
    const url = await uploadedUrl(target, target.member);
    const original = await avatarRows(target.organization.id);
    expect(original).toHaveLength(1);
    await expectUnavailable(await uploadAvatar(target, target.member, undefined, { env: previewEnv }));
    await expectUnavailable(await getAvatar(url, target.member, { env: previewEnv }));
    await expectUnavailable(await deleteAvatar(target, target.member, { env: previewEnv }));
    expect(await avatarRows(target.organization.id)).toEqual(original);
  });

  test('R2 がない場合も未認証・別組織への呼び出しは従来の認証結果になる', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const body = { workspace_id: target.workspace.id, file_name: '画面.png' };
    const anonymous = await post(app, attachmentUpload, { slug: target.slug, body, env: previewEnv });
    expect(anonymous.status).toBe(401);
    const foreign = await post(app, attachmentUpload, {
      slug: target.slug,
      token: other.member.token,
      body,
      env: previewEnv,
    });
    expect(foreign.status).toBe(404);
  });

  test('専用プレビュー以外では同じ環境変数があっても既存の R2 を使う', async () => {
    const target = await createTarget();
    const normalEnv = { ...testEnv, PREVIEW_WITHOUT_ATTACHMENTS: '1' };
    expect((await upload(target, { env: normalEnv })).status).toBe(200);
  });
});
