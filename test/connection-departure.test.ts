// いなくなった人の接続（#1546）。ワークスペースを抜けると、そのワークスペースのその人の接続が member_left で止まり、
// ユーザーを無効にすると、その人のすべての接続が user_disabled で止まって認証情報の列が消える。
// 既に別の理由で止まった接続の理由は変わらず、止めた接続は同期の仕組みが取り込み元に問い合わせない
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { userDisable } from '../src/shared/operations/organization/index.ts';
import { membershipLeave } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { syncConnection } from '../src/server/import/sync.ts';
import type { ImportSource } from '../src/server/import/source.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createConnection, createConnectionScope, createMembership, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp([...implementedOperations]);

// 認証情報の3列（組で入る）。値は架空
const CREDENTIAL = { credential_ciphertext: 'v1.fake-cipher', credential_key_version: 1, credential_last4: 'ZZ01' };

function leave(target: Target, caller: Person, userId: string) {
  return post(app, membershipLeave, {
    slug: target.slug,
    token: caller.token,
    body: { workspace_id: target.workspace.id, user_id: userId },
  });
}

function disable(target: Target, userId: string) {
  return post(app, userDisable, { slug: target.slug, token: target.admin.token, body: { user_id: userId } });
}

async function connectionOf(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(db.statement((q) => q.selectFrom('connections').selectAll().where('id', '=', id)));
  if (row === undefined) throw new Error('接続が無い');
  return row;
}

async function connectionLogs(target: Target) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['entity_id', 'workspace_id', 'actor_user_id', 'action', 'changes_json'])
        .where('organization_id', '=', db.organizationId)
        .where('entity_type', '=', 'connection'),
    ),
  );
  return new Map(rows.map((row) => [row.entity_id, { ...row, changes: JSON.parse(row.changes_json) as unknown }]));
}

// 呼ばれたら落ちる取り込み元（止まった接続で問い合わせないことを見る）
const untouchable: ImportSource = new Proxy({} as ImportSource, {
  get(_target, key) {
    if (key === 'kind') return 'github';
    if (key === 'then') return undefined;
    throw new Error(`取り込み元に問い合わせた: ${String(key)}`);
  },
});

describe('membership-leave の接続', () => {
  test('自分で抜けると、そのワークスペースの自分の接続が member_left で止まり、同期されない。ほかは変わらない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const active = await createConnection(target.organization, target.workspace.id, memberId, CREDENTIAL);
    await createConnectionScope(target.organization, active.id);
    const failing = await createConnection(target.organization, target.workspace.id, memberId, {
      ...CREDENTIAL,
      status: 'error',
      consecutive_failures: 2,
    });
    const otherWorkspace = await createConnection(target.organization, target.otherWorkspace.id, memberId, CREDENTIAL);
    const leaders = await createConnection(target.organization, target.workspace.id, target.leader.userId!, CREDENTIAL);

    expect((await leave(target, target.member, memberId)).status).toBe(200);

    for (const id of [active.id, failing.id]) {
      const row = await connectionOf(target, id);
      expect(row).toMatchObject({ status: 'stopped', stopped_reason: 'member_left' });
      // 離脱では認証情報を消さない（消すのは退会＝無効化）
      expect(row.credential_ciphertext).toBe(CREDENTIAL.credential_ciphertext);
      expect(row.updated_at).not.toBe(active.updated_at);
    }
    expect(await connectionOf(target, otherWorkspace.id)).toMatchObject({ status: 'active', stopped_reason: null });
    expect(await connectionOf(target, leaders.id)).toMatchObject({ status: 'active', stopped_reason: null });

    const logs = await connectionLogs(target);
    expect(logs.size).toBe(2);
    expect(logs.get(active.id)).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: memberId,
      action: 'update',
      changes: { status: ['active', 'stopped'], stopped_reason: [null, 'member_left'] },
    });
    expect(logs.get(failing.id)?.changes).toEqual({
      status: ['error', 'stopped'],
      stopped_reason: [null, 'member_left'],
    });

    // 同期は抜けた人の接続を読まない。所属し直しても、止まった接続は取り込み元に問い合わせない
    const db = orgDb(env, target.organization.verified);
    expect(await syncConnection(env, db, target.workspace.id, active.id, { source: untouchable })).toEqual({
      outcome: 'not_found',
    });
    await createMembership(target.organization, target.workspace.id, memberId, { joined_on: '2026-11-27' });
    expect(await syncConnection(env, db, target.workspace.id, active.id, { source: untouchable })).toEqual({
      outcome: 'stopped',
    });
  });

  test('リーダーが外したときも止まり、履歴の操作者はリーダー', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const connection = await createConnection(target.organization, target.workspace.id, memberId, CREDENTIAL);

    expect((await leave(target, target.leader, memberId)).status).toBe(200);

    expect(await connectionOf(target, connection.id)).toMatchObject({
      status: 'stopped',
      stopped_reason: 'member_left',
    });
    expect((await connectionLogs(target)).get(connection.id)?.actor_user_id).toBe(target.leader.userId);
  });

  test('既に別の理由で止まった接続と削除した接続は書き換えず、履歴も残さない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const byOwner = await createConnection(target.organization, target.workspace.id, memberId, {
      ...CREDENTIAL,
      status: 'stopped',
      stopped_reason: 'owner',
    });
    const authFailed = await createConnection(target.organization, target.workspace.id, memberId, {
      ...CREDENTIAL,
      status: 'stopped',
      stopped_reason: 'auth_failed',
    });
    const deleted = await createConnection(target.organization, target.workspace.id, memberId, {
      deleted_at: '2026-11-02T00:00:00.000Z',
    });

    expect((await leave(target, target.member, memberId)).status).toBe(200);

    expect(await connectionOf(target, byOwner.id)).toEqual(byOwner);
    expect(await connectionOf(target, authFailed.id)).toEqual(authFailed);
    expect(await connectionOf(target, deleted.id)).toEqual(deleted);
    expect((await connectionLogs(target)).size).toBe(0);
  });

  test('所属が終わらなかった（一般のメンバーが他人を外そうとした）ときは接続を止めない', async () => {
    const target = await createTarget();
    const leaderId = target.leader.userId!;
    const connection = await createConnection(target.organization, target.workspace.id, leaderId, CREDENTIAL);

    expect((await leave(target, target.member, leaderId)).status).toBe(403);

    expect(await connectionOf(target, connection.id)).toEqual(connection);
    expect((await connectionLogs(target)).size).toBe(0);
  });
});

describe('user-disable の接続', () => {
  test('すべてのワークスペースの接続が user_disabled で止まり、PAT が DB に残らない。同期されない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      closed_at: '2026-11-01T00:00:00.000Z',
    });
    const removed = await createWorkspace(target.organization, target.admin.userId!, {
      closed_at: '2026-11-01T00:00:00.000Z',
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    const here = await createConnection(target.organization, target.workspace.id, memberId, {
      ...CREDENTIAL,
      sync_state_json: '{"version":2,"credential":"fp"}',
      reconcile_state_json: '{"after":"x"}',
    });
    await createConnectionScope(target.organization, here.id);
    const other = await createConnection(target.organization, target.otherWorkspace.id, memberId, {
      ...CREDENTIAL,
      status: 'error',
    });
    const inClosed = await createConnection(target.organization, closed.id, memberId, CREDENTIAL);
    const inRemoved = await createConnection(target.organization, removed.id, memberId, CREDENTIAL);
    const leaders = await createConnection(target.organization, target.workspace.id, target.leader.userId!, CREDENTIAL);

    expect((await disable(target, memberId)).status).toBe(200);

    for (const id of [here.id, other.id, inClosed.id, inRemoved.id]) {
      expect(await connectionOf(target, id)).toMatchObject({
        status: 'stopped',
        stopped_reason: 'user_disabled',
        credential_ciphertext: null,
        credential_key_version: null,
        credential_last4: null,
        sync_state_json: '{}',
        reconcile_state_json: '{}',
      });
    }
    expect(await connectionOf(target, leaders.id)).toEqual(leaders);

    const logs = await connectionLogs(target);
    expect(logs.size).toBe(4);
    expect(logs.get(here.id)).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.admin.userId,
      action: 'update',
      changes: {
        status: ['active', 'stopped'],
        stopped_reason: [null, 'user_disabled'],
        credential_removed: [null, true],
      },
    });
    expect(logs.get(other.id)?.changes).toEqual({
      status: ['error', 'stopped'],
      stopped_reason: [null, 'user_disabled'],
      credential_removed: [null, true],
    });
    expect(logs.get(inRemoved.id)?.workspace_id).toBe(removed.id);
    // 履歴にも認証情報の値は残らない
    for (const log of logs.values()) expect(log.changes_json).not.toContain(CREDENTIAL.credential_ciphertext);

    // 同期は無効の人の接続を読まず、取り込み元に問い合わせない
    const db = orgDb(env, target.organization.verified);
    expect(await syncConnection(env, db, target.workspace.id, here.id, { source: untouchable })).toEqual({
      outcome: 'not_found',
    });
  });

  test('既に別の理由で止まった接続は理由を変えず、認証情報だけを消す。削除した接続と空の認証情報の停止済みは触らない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const byLeader = await createConnection(target.organization, target.workspace.id, memberId, {
      ...CREDENTIAL,
      status: 'stopped',
      stopped_reason: 'leader',
    });
    const leftBefore = await createConnection(target.organization, target.otherWorkspace.id, memberId, {
      ...CREDENTIAL,
      status: 'stopped',
      stopped_reason: 'member_left',
    });
    const empty = await createConnection(target.organization, target.workspace.id, memberId, {
      status: 'stopped',
      stopped_reason: 'auth_failed',
    });
    const deleted = await createConnection(target.organization, target.workspace.id, memberId, {
      deleted_at: '2026-11-02T00:00:00.000Z',
    });

    expect((await disable(target, memberId)).status).toBe(200);

    expect(await connectionOf(target, byLeader.id)).toMatchObject({
      status: 'stopped',
      stopped_reason: 'leader',
      credential_ciphertext: null,
      credential_key_version: null,
      credential_last4: null,
    });
    expect(await connectionOf(target, leftBefore.id)).toMatchObject({
      stopped_reason: 'member_left',
      credential_ciphertext: null,
    });
    expect(await connectionOf(target, empty.id)).toEqual(empty);
    expect(await connectionOf(target, deleted.id)).toEqual(deleted);

    const logs = await connectionLogs(target);
    expect(logs.size).toBe(2);
    expect(logs.get(byLeader.id)?.changes).toEqual({ credential_removed: [null, true] });
    expect(logs.get(leftBefore.id)?.changes).toEqual({ credential_removed: [null, true] });
  });

  test('無効にできなかった（自分を指した）ときと、既に無効の人では接続を変えない', async () => {
    const target = await createTarget();
    const adminsConnection = await createConnection(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      CREDENTIAL,
    );
    expect((await disable(target, target.admin.userId!)).status).toBe(409);
    expect(await connectionOf(target, adminsConnection.id)).toEqual(adminsConnection);

    const memberId = target.member.userId!;
    expect((await disable(target, memberId)).status).toBe(200);
    // 無効にした後に入った行（無効の人の接続は作れないが、再送で書き換えないことを見る）
    const late = await createConnection(target.organization, target.workspace.id, memberId, CREDENTIAL);
    expect((await disable(target, memberId)).status).toBe(200);
    expect(await connectionOf(target, late.id)).toEqual(late);
  });
});
