import { expect, test } from 'vitest';
import { workspaceClose, workspaceDelete } from '../src/shared/operations/workspace/index.ts';
import { createMembership } from './factories.ts';
import { app, avatarRowOf, getAvatar, objectBytes, uploadedUrl } from './me-avatar-helpers.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

test('削除で組織への所属をすべて失う人の画像を消し、組織に入れる人の画像は残す', async () => {
  const target = await createTarget();
  const { slug, organization, workspace, otherWorkspace, admin, member, leader } = target;
  await createMembership(organization, otherWorkspace.id, leader.userId!);
  await createMembership(organization, workspace.id, admin.userId!);

  const memberUrl = await uploadedUrl(target, member);
  const leaderUrl = await uploadedUrl(target, leader);
  const adminUrl = await uploadedUrl(target, admin);
  const memberImage = (await avatarRowOf(target, member))!;
  const leaderImage = (await avatarRowOf(target, leader))!;
  const adminImage = (await avatarRowOf(target, admin))!;

  const adminRequest = { slug, token: admin.token };
  const workspaceInput = { workspace_id: workspace.id };
  expect((await post(app, workspaceClose, { ...adminRequest, body: workspaceInput })).status).toBe(200);
  expect(await avatarRowOf(target, member)).toEqual(memberImage);
  expect(
    (
      await post(app, workspaceDelete, {
        ...adminRequest,
        body: { ...workspaceInput, confirm_name: workspace.name },
      })
    ).status,
  ).toBe(200);

  expect(await avatarRowOf(target, member)).toBeUndefined();
  expect(await objectBytes(memberImage.object_key)).toBeUndefined();
  expect((await getAvatar(memberUrl, admin)).status).toBe(404);

  expect(await avatarRowOf(target, leader)).toEqual(leaderImage);
  expect(await objectBytes(leaderImage.object_key)).toBeDefined();
  expect((await getAvatar(leaderUrl, admin)).status).toBe(200);
  expect(await avatarRowOf(target, admin)).toEqual(adminImage);
  expect(await objectBytes(adminImage.object_key)).toBeDefined();
  expect((await getAvatar(adminUrl, admin)).status).toBe(200);
});
