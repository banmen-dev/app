import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { workspaceDelete, workspaceInfo } from '../src/shared/operations/workspace/index.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv } from './operations/world.ts';

const app = createApp(implementedOperations);

test('本番は有効化の前に削除を断り、有効化後の削除済みデータは無効時にも開けない', async () => {
  const target = await createTarget({ closed: true });
  const { slug, workspace, admin } = target;
  const normal = Object.assign({}, testEnv, { WORKSPACE_DELETE_ENABLED: 'false' });
  const enabled = Object.assign({}, normal, { WORKSPACE_DELETE_ENABLED: 'true' });
  const unset = Object.assign({}, normal, { WORKSPACE_DELETE_ENABLED: undefined });
  const read = (requestEnv: Env) =>
    post(app, workspaceInfo, {
      slug,
      token: admin.token,
      body: { workspace_id: workspace.id, include_lifecycle_options: true },
      env: requestEnv,
    });
  const remove = (requestEnv: Env) =>
    post(app, workspaceDelete, {
      slug,
      token: admin.token,
      body: { workspace_id: workspace.id, confirm_name: workspace.name },
      env: requestEnv,
    });

  expect((await remove(normal)).status).toBe(404);
  expect((await remove(unset)).status).toBe(404);
  expect(await (await read(unset)).json()).toMatchObject({ workspace_delete_enabled: false });
  expect(await (await read(normal)).json()).toMatchObject({ workspace_delete_enabled: false });
  expect(await (await read(enabled)).json()).toMatchObject({ workspace_delete_enabled: true });
  expect((await remove(enabled)).status).toBe(200);
  expect((await read(normal)).status).toBe(404);
});

test('削除オプションは管理者が明示して問い合わせた場合にだけ返す', async () => {
  const { slug, workspace, admin, leader } = await createTarget({ closed: true });
  const enabled = Object.assign({}, testEnv, { WORKSPACE_DELETE_ENABLED: 'true' });
  const workspaceOnly = { workspace_id: workspace.id };
  const ordinaryRead = await post(app, workspaceInfo, { slug, token: admin.token, body: workspaceOnly, env: enabled });
  const leaderRead = await post(app, workspaceInfo, {
    slug,
    token: leader.token,
    body: { ...workspaceOnly, include_lifecycle_options: true },
    env: enabled,
  });
  for (const response of [ordinaryRead, leaderRead]) {
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('workspace_delete_enabled');
  }
});
