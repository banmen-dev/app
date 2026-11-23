import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, readSyncConnection, syncOutcomeStatement } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { invitationDecline, workspaceClose, workspaceDelete } from '../src/shared/operations/workspace/index.ts';
import { createConnection, createInvitation } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function deleteWorkspace({ slug, admin, workspace }: Target) {
  return post(app, workspaceDelete, {
    slug,
    token: admin.token,
    body: { workspace_id: workspace.id, confirm_name: workspace.name },
  });
}

test('削除前に読み取った同期の結果は、削除後の接続に書き込めない', async () => {
  const target = await createTarget();
  const { organization, workspace, leader, admin, slug } = target;
  const db = orgDb(env, organization.verified);
  const connection = await createConnection(organization, workspace.id, leader.userId!);
  const read = await readSyncConnection(db, workspace.id, connection.id);
  expect(read).toBeDefined();

  const closed = await post(app, workspaceClose, {
    slug,
    token: admin.token,
    body: { workspace_id: workspace.id },
  });
  expect(closed.status).toBe(200);
  expect((await deleteWorkspace(target)).status).toBe(200);

  const result = await db.run(
    syncOutcomeStatement(
      db,
      { id: read!.connection.id, workspaceId: read!.connection.workspace_id },
      { kind: 'success', syncStateJson: '{"next":"later"}' },
      '2026-11-23T00:00:00.000Z',
    ),
  );
  expect(result.changes).toBe(0);
  expect(await readSyncConnection(db, workspace.id, connection.id)).toBeUndefined();
  const retained = await db.first(
    db.statement((q) =>
      q.selectFrom('connections').selectAll().where('id', '=', connection.id).where('workspace_id', '=', workspace.id),
    ),
  );
  expect(retained).toEqual(connection);
});

test('終了済みのワークスペースからの招待を読んだ直後に削除されると、辞退も履歴も書き込まない', async () => {
  const target = await createTarget({ closed: true });
  const { organization, workspace, admin, slug } = target;
  const otherInvitee = await createPerson();
  const invitation = await createInvitation(organization, workspace.id, admin.userId!, otherInvitee.login);
  const db = orgDb(env, organization.verified);
  let deleted = false;
  const racing = envWithD1Hooks(testEnv, {
    afterQuery: async (query) => {
      if (deleted || !query.includes('from "invitations" as "i"') || !query.includes('"i"."id" = ?')) return;
      const response = await deleteWorkspace(target);
      expect(response.status).toBe(200);
      deleted = true;
    },
  });

  const declined = await post(app, invitationDecline, {
    slug,
    token: otherInvitee.token,
    body: { invitation_id: invitation.id },
    env: racing,
  });
  expect(deleted).toBe(true);
  expect(declined.status).toBe(404);
  expect(await errorCodeOf(declined)).toBe('not_found');
  const [retained, declineHistory] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('invitations')
        .select(['status', 'responded_at'])
        .where('id', '=', invitation.id)
        .where('workspace_id', '=', workspace.id),
    ),
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select('id')
        .where('organization_id', '=', organization.id)
        .where('workspace_id', '=', workspace.id)
        .where('entity_type', '=', 'invitation')
        .where('entity_id', '=', invitation.id),
    ),
  ]);
  expect(retained.rows).toEqual([{ status: 'pending', responded_at: null }]);
  expect(declineHistory.rows).toEqual([]);
});
