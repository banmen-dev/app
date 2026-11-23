import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { myOrganizations, organizationHistory, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { taskCreate } from '../src/shared/operations/task/index.ts';
import { workspaceWikiCreate, workspaceWikiPage } from '../src/shared/operations/wiki/index.ts';
import {
  invitationAccept,
  invitationList,
  workspaceClose,
  workspaceDelete,
  workspaceInfo,
  workspaceList,
  workspaceReopen,
} from '../src/shared/operations/workspace/index.ts';
import { download, storedFile } from './attachment-download-helpers.ts';
import { AT, createInvitation, createMembership, createTask, createWorkspace } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPersonalTarget, createPerson, createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const workspaceName = '青葉チーム';

function adminRequest(target: Target) {
  return { slug: target.slug, token: target.admin.token };
}

function remove(target: Target, options: { id?: string; confirmName?: string; token?: string; env?: Env } = {}) {
  return post(app, workspaceDelete, {
    ...adminRequest(target),
    ...(options.token === undefined ? {} : { token: options.token }),
    env: options.env,
    body: { workspace_id: options.id ?? target.workspace.id, confirm_name: options.confirmName ?? workspaceName },
  });
}

async function history(target: Target) {
  const response = await post(app, organizationHistory, adminRequest(target));
  expect(response.status).toBe(200);
  return organizationHistory.output.parse(await response.json()).entries;
}

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(await errorCodeOf(response)).toBe('not_found');
}

describe('workspace-delete', () => {
  test('終了済みのワークスペースを所属外の管理者が削除し、再送と再開を断って変更の履歴を1件残す', async () => {
    const target = await createTarget({ closed: true });
    const workspaceInput = { workspace_id: target.workspace.id };
    const response = await remove(target);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(workspaceInput);

    await expectNotFound(await remove(target));
    for (const operation of [workspaceInfo, workspaceReopen]) {
      await expectNotFound(await post(app, operation, { ...adminRequest(target), body: workspaceInput }));
    }
    await expectNotFound(
      await post(app, taskCreate, { ...adminRequest(target), body: { ...workspaceInput, title: '新しいタスク' } }),
    );
    const entries = await history(target);
    expect(entries).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'user', id: target.admin.userId }),
        event: { kind: 'workspace_deleted', workspace_name: workspaceName },
      }),
    ]);
    expect(Number.isNaN(Date.parse(entries[0]!.created_at))).toBe(false);
  });

  test('自分用の持ち主も終了済みのワークスペースを削除できる', async () => {
    const target = await createPersonalTarget();
    const workspace = await createWorkspace(target.organization, target.admin.userId!, { closed_at: AT });

    const response = await remove(target, { id: workspace.id, confirmName: workspace.name });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace_id: workspace.id });
  });

  test('利用中のワークスペースと、確認名が一致しないワークスペースは削除できない', async () => {
    const target = await createTarget({ closed: true });
    const cases = [
      { input: { id: target.otherWorkspace.id }, reason: 'workspace_not_closed' },
      { input: { confirmName: `${workspaceName} ` }, reason: 'workspace_name_mismatch' },
    ];
    for (const { input, reason } of cases) {
      const response = await remove(target, input);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason } } });
    }

    const list = await post(app, workspaceList, adminRequest(target));
    expect(list.status).toBe(200);
    const { workspaces } = workspaceList.output.parse(await list.json());
    expect(workspaces.map(({ id }) => id).sort()).toEqual([target.workspace.id, target.otherWorkspace.id].sort());
    expect(await history(target)).toEqual([]);
  });

  test('リーダー・一般メンバー・無効な管理者・他組織の管理者は削除できない', async () => {
    const target = await createTarget({ closed: true });
    const other = await createTarget({ closed: true });
    const disabled = await createPerson({ organization: target.organization, admin: true, disabled: true });

    for (const person of [target.leader, target.member]) {
      const response = await remove(target, { token: person.token });
      expect(response.status).toBe(403);
      expect(await errorCodeOf(response)).toBe('forbidden');
    }
    await expectNotFound(await remove(target, { token: disabled.token }));
    await expectNotFound(await remove(target, { token: other.admin.token }));
    await expectNotFound(await remove(other, { id: target.workspace.id }));
    expect(await history(target)).toEqual([]);
    expect(await history(other)).toEqual([]);
  });

  test('再開と同時に要求しても一方だけが成功し、成立した変更だけが履歴に残る', async () => {
    const target = await createTarget({ closed: true });
    const request = { ...adminRequest(target), body: { workspace_id: target.workspace.id } };
    const [deleted, reopened] = await Promise.all([remove(target), post(app, workspaceReopen, request)]);

    expect([deleted.status, reopened.status].filter((status) => status === 200)).toHaveLength(1);
    const entries = await history(target);
    expect(entries).toHaveLength(1);
    const info = await post(app, workspaceInfo, request);
    if (deleted.status === 200) {
      await expectNotFound(reopened);
      await expectNotFound(info);
      expect(entries[0]!.event.kind).toBe('workspace_deleted');
    } else {
      expect(deleted.status).toBe(409);
      expect(await errorCodeOf(deleted)).toBe('conflict');
      expect(info.status).toBe(200);
      expect(workspaceInfo.output.parse(await info.json()).closed_at).toBeNull();
      expect(entries[0]!.event.kind).toBe('workspace_reopened');
    }
  });

  test('ワークスペースを確かめた直後に管理権限を失うと削除できない', async () => {
    const target = await createTarget({ closed: true });
    const backupAdmin = await createPerson({ organization: target.organization, admin: true });
    const db = orgDb(env, target.organization.verified);
    let demoted = false;
    const bindings = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (demoted || !sql.includes('from "workspaces" as "w"') || !sql.includes('"m"."role"')) return;
        demoted = true;
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('users')
              .set({ is_admin: 0 })
              .where('organization_id', '=', target.organization.id)
              .where('id', '=', target.admin.userId!),
          ),
        ]);
      },
    });

    const response = await remove(target, { env: bindings });
    expect(demoted).toBe(true);
    expect([403, 404]).toContain(response.status);
    const list = await post(app, workspaceList, { slug: target.slug, token: backupAdmin.token });
    expect(list.status).toBe(200);
    expect(workspaceList.output.parse(await list.json()).workspaces).toContainEqual(
      expect.objectContaining({ id: target.workspace.id }),
    );
    expect(await history({ ...target, admin: backupAdmin })).toEqual([]);
  });

  test('管理一覧・所属・星・Wiki・添付から消し、保存データは組織の容量に計上する', async () => {
    const target = await createTarget();
    const admin = adminRequest(target);
    const workspaceId = target.workspace.id;
    await createMembership(target.organization, workspaceId, target.admin.userId!);
    await createMembership(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const task = await createTask(target.organization, workspaceId, target.admin.userId!);
    const { row: attachment } = await storedFile(target, { row: { task_id: task.id, attached_at: AT } });
    const favorite = await post(app, favoriteSet, {
      ...admin,
      body: { target_type: 'task', target_id: task.id, is_favorite: true },
    });
    expect(favorite.status).toBe(200);
    const created = await post(app, workspaceWikiCreate, {
      ...admin,
      body: { workspace_id: workspaceId, title: '操作手順', body_md: '確認する' },
    });
    expect(created.status).toBe(200);
    const { page } = workspaceWikiCreate.output.parse(await created.json());
    expect((await post(app, workspaceClose, { ...admin, body: { workspace_id: workspaceId } })).status).toBe(200);
    const readOrganization = async () => {
      const response = await post(app, organizationInfo, { ...admin, body: { include_storage: true } });
      expect(response.status).toBe(200);
      return organizationInfo.output.parse(await response.json());
    };
    const before = await readOrganization();
    expect(before.workspaces.map(({ id }) => id)).toContain(workspaceId);
    expect(before.storage?.used_bytes).toBeGreaterThan(attachment.size_bytes);

    expect((await remove(target)).status).toBe(200);

    const listing = await post(app, workspaceList, admin);
    expect(listing.status).toBe(200);
    expect(workspaceList.output.parse(await listing.json()).workspaces.map(({ id }) => id)).toEqual([
      target.otherWorkspace.id,
    ]);
    const after = await readOrganization();
    expect(after.workspaces.map(({ id }) => id)).toEqual([target.otherWorkspace.id]);
    expect(after.storage?.used_bytes).toBe(before.storage?.used_bytes);
    expect(after.storage?.workspaces).toContainEqual(
      expect.objectContaining({ id: workspaceId, used_bytes: before.storage?.used_bytes }),
    );

    const favorites = await post(app, favoriteList, admin);
    expect(favorites.status).toBe(200);
    expect(favoriteList.output.parse(await favorites.json())).toEqual({ marks: [], favorites: [] });
    await expectNotFound(
      await post(app, workspaceWikiPage, { ...admin, body: { workspace_id: workspaceId, page_id: page.id } }),
    );
    await expectNotFound(await download(target, attachment.id, { person: target.admin }));
    expect(await env.ATTACHMENTS.head(attachment.object_key)).not.toBeNull();
  });

  test('対象だけに所属する人の入場と、対象への招待の表示・承諾を止める', async () => {
    const target = await createTarget({ closed: true });
    await createInvitation(target.organization, target.otherWorkspace.id, target.admin.userId!, target.invitee.login);
    const invitee = { slug: target.slug, token: target.invitee.token };
    const before = await post(app, invitationList, invitee);
    expect(before.status).toBe(200);
    const { invitations } = invitationList.output.parse(await before.json());
    const deletedInvitation = invitations.find(({ workspace_id }) => workspace_id === target.workspace.id)!;
    expect(deletedInvitation.closed).toBe(true);

    expect((await remove(target)).status).toBe(200);

    const after = await post(app, invitationList, invitee);
    expect(after.status).toBe(200);
    expect(invitationList.output.parse(await after.json()).invitations.map(({ workspace_id }) => workspace_id)).toEqual(
      [target.otherWorkspace.id],
    );
    await expectNotFound(
      await post(app, invitationAccept, { ...invitee, body: { invitation_id: deletedInvitation.invitation_id } }),
    );
    await expectNotFound(await post(app, organizationInfo, { slug: target.slug, token: target.member.token }));
    const organizations = await post(app, myOrganizations, { token: target.member.token });
    expect(organizations.status).toBe(200);
    expect(myOrganizations.output.parse(await organizations.json()).organizations).toEqual([]);
    expect((await post(app, organizationInfo, { slug: target.slug, token: target.bystander.token })).status).toBe(200);
  });
});
