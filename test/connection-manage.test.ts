// 接続の停止と削除（connection-stop、connection-delete）。本人はリーダーでなくても自分の接続を止め、消せる。
// リーダーと管理者は同じワークスペースの他のメンバーの接続を止め、消せるが、範囲は直せない。メンバーは他の人の接続に触れず、
// 別の組織と削除済みの接続は 404。消した接続は認証情報の列が空になり、取り込み済みのタスクは残る（docs/requirements.md の「取り込み」）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  connectionDelete,
  connectionList,
  connectionScopesSave,
  connectionStop,
} from '../src/shared/operations/connection/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { afterFirstQuery } from './auth/helpers.ts';
import { createConnection, createTask, createTaskSource } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// 認証情報を持つ接続を、持ち主を指定して作る（暗号文の中身は見ない）
function connectionOf(target: Target, owner: Person, overrides: Parameters<typeof createConnection>[3] = {}) {
  return createConnection(target.organization, target.workspace.id, owner.userId!, {
    credential_ciphertext: 'sealed',
    credential_key_version: 1,
    credential_last4: 'abcd',
    sync_state_json: '{"cursor":"x"}',
    last_success_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });
}

function call(
  op: typeof connectionStop | typeof connectionDelete,
  target: Target,
  caller: Person,
  id: string,
  bindings: Env = env,
) {
  return post(app, op, {
    env: bindings,
    slug: target.slug,
    token: caller.token,
    body: { workspace_id: target.workspace.id, connection_id: id },
  });
}

async function rowOf(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(db.statement((q) => q.selectFrom('connections').selectAll().where('id', '=', id)));
}

async function logsOf(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['actor_user_id', 'action', 'changes_json'])
        .where('entity_type', '=', 'connection')
        .where('entity_id', '=', id),
    ),
  );
}

describe('connection-stop', () => {
  test('本人は自分の接続を owner の理由で止められ、履歴に残る。範囲は変わらない', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member);

    const res = await call(connectionStop, target, target.member, row.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connection: { id: row.id, status: 'stopped', stopped_reason: 'owner' } });
    expect(await rowOf(target, row.id)).toMatchObject({ status: 'stopped', stopped_reason: 'owner' });
    const logs = await logsOf(target, row.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_user_id: target.member.userId, action: 'update' });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      status: ['active', 'stopped'],
      stopped_reason: [null, 'owner'],
    });
  });

  test('リーダーと管理者は他のメンバーの接続を leader の理由で止められる', async () => {
    const target = await createTarget();
    const byLeader = await connectionOf(target, target.member);
    const byAdmin = await connectionOf(target, target.member);

    expect((await call(connectionStop, target, target.leader, byLeader.id)).status).toBe(200);
    expect((await call(connectionStop, target, target.admin, byAdmin.id)).status).toBe(200);
    expect(await rowOf(target, byLeader.id)).toMatchObject({ status: 'stopped', stopped_reason: 'leader' });
    expect(await rowOf(target, byAdmin.id)).toMatchObject({ status: 'stopped', stopped_reason: 'leader' });
  });

  test('リーダーが自分の接続を止めたときは owner', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.leader);
    expect((await call(connectionStop, target, target.leader, row.id)).status).toBe(200);
    expect(await rowOf(target, row.id)).toMatchObject({ stopped_reason: 'owner' });
  });

  test('管理者が自分の接続を止めたときも owner（ワークスペースの非メンバーでも）', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.admin);
    expect((await call(connectionStop, target, target.admin, row.id)).status).toBe(200);
    expect(await rowOf(target, row.id)).toMatchObject({ stopped_reason: 'owner' });
  });

  test('メンバーは他のメンバーの接続を止められない（403）。何も書かない', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.leader);

    expect((await call(connectionStop, target, target.member, row.id)).status).toBe(403);
    expect(await rowOf(target, row.id)).toMatchObject({ status: 'active', stopped_reason: null });
    expect(await logsOf(target, row.id)).toEqual([]);
  });

  test('本人が再開できる理由で止まった接続は、止めると owner か leader に変わり、再開しない停止になる', async () => {
    const target = await createTarget();
    const auth = await connectionOf(target, target.member, { status: 'stopped', stopped_reason: 'auth_failed' });
    const left = await connectionOf(target, target.member, { status: 'stopped', stopped_reason: 'member_left' });

    expect((await call(connectionStop, target, target.leader, auth.id)).status).toBe(200);
    expect((await call(connectionStop, target, target.member, left.id)).status).toBe(200);
    expect(await rowOf(target, auth.id)).toMatchObject({ status: 'stopped', stopped_reason: 'leader' });
    expect(await rowOf(target, left.id)).toMatchObject({ status: 'stopped', stopped_reason: 'owner' });
    expect(JSON.parse((await logsOf(target, auth.id))[0]!.changes_json)).toEqual({
      status: ['stopped', 'stopped'],
      stopped_reason: ['auth_failed', 'leader'],
    });
  });

  test('owner、leader、workspace_closed で止まっている接続は理由を書き換えず、履歴も足さない', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member, { status: 'stopped', stopped_reason: 'owner' });

    const res = await call(connectionStop, target, target.leader, row.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connection: { status: 'stopped', stopped_reason: 'owner' } });
    expect(await rowOf(target, row.id)).toMatchObject({ stopped_reason: 'owner' });
    expect(await logsOf(target, row.id)).toEqual([]);
  });

  test('ワークスペースを抜けた持ち主の接続も、リーダーが止められる', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: '2026-11-01T00:00:00.000Z', left_on: '2026-11-01' })
          .where('user_id', '=', target.member.userId!)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await call(connectionStop, target, target.leader, row.id)).status).toBe(200);
    expect(await rowOf(target, row.id)).toMatchObject({ status: 'stopped', stopped_reason: 'leader' });
  });

  test('別のワークスペースと削除済みの接続は 404', async () => {
    const target = await createTarget();
    const other = await createConnection(target.organization, target.otherWorkspace.id, target.member.userId!);
    const gone = await connectionOf(target, target.member, {
      deleted_at: '2026-11-01T00:00:00.000Z',
      credential_ciphertext: null,
      credential_key_version: null,
      credential_last4: null,
    });

    expect((await call(connectionStop, target, target.leader, other.id)).status).toBe(404);
    expect((await call(connectionStop, target, target.leader, gone.id)).status).toBe(404);
  });

  test('別の組織の接続は 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const row = await connectionOf(foreign, foreign.member);

    expect((await call(connectionStop, target, target.admin, row.id)).status).toBe(404);
    expect(await rowOf(foreign, row.id)).toMatchObject({ status: 'active' });
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const row = await connectionOf(target, target.member);

    const res = await call(connectionStop, target, target.admin, row.id);
    expect(res.status).toBe(409);
    expect(await rowOf(target, row.id)).toMatchObject({ status: 'active' });
  });

  test('止めた接続は一覧に止まった理由つきで残る', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member);
    await call(connectionStop, target, target.leader, row.id);

    const list = await post(app, connectionList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(await list.json()).toMatchObject({
      connections: [{ id: row.id, status: 'stopped', stopped_reason: 'leader' }],
    });
  });
});

describe('connection-delete', () => {
  test('本人が消すと一覧から消え、認証情報と続きの位置が DB に残らない。取り込み済みのタスクは残る', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member);
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    await createTaskSource(target.organization, target.workspace.id, task.id, row.id);

    const res = await call(connectionDelete, target, target.member, row.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connection_id: row.id });
    expect(await rowOf(target, row.id)).toMatchObject({
      credential_ciphertext: null,
      credential_key_version: null,
      credential_last4: null,
      sync_state_json: '{}',
      reconcile_state_json: '{}',
      last_success_at: null,
    });
    expect((await rowOf(target, row.id))!.deleted_at).not.toBeNull();

    const db = orgDb(env, target.organization.verified);
    const sources = await db.rows(
      db.statement((q) => q.selectFrom('task_sources').select('task_id').where('connection_id', '=', row.id)),
    );
    expect(sources).toEqual([{ task_id: task.id }]);
    const list = await post(app, connectionList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(await list.json()).toEqual({ connections: [] });

    const logs = await logsOf(target, row.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'delete', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      name: ['あおばの GitHub', null],
      credential_removed: [null, true],
    });
    expect(logs[0]!.changes_json).not.toContain('sealed');
  });

  test('止まっている接続も消せ、リーダーと管理者は他のメンバーの接続を消せる', async () => {
    const target = await createTarget();
    const stopped = await connectionOf(target, target.member, { status: 'stopped', stopped_reason: 'member_left' });
    const byAdmin = await connectionOf(target, target.leader);

    expect((await call(connectionDelete, target, target.leader, stopped.id)).status).toBe(200);
    expect((await call(connectionDelete, target, target.admin, byAdmin.id)).status).toBe(200);
    expect((await rowOf(target, stopped.id))!.deleted_at).not.toBeNull();
    expect((await rowOf(target, byAdmin.id))!.deleted_at).not.toBeNull();
  });

  test('認証情報が既に無い接続を消しても、履歴に credential_removed は入らない', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member, {
      status: 'stopped',
      stopped_reason: 'user_disabled',
      credential_ciphertext: null,
      credential_key_version: null,
      credential_last4: null,
    });

    expect((await call(connectionDelete, target, target.leader, row.id)).status).toBe(200);
    expect(JSON.parse((await logsOf(target, row.id))[0]!.changes_json)).toEqual({ name: ['あおばの GitHub', null] });
  });

  test('メンバーは他のメンバーの接続を消せない（403）', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.leader);

    expect((await call(connectionDelete, target, target.member, row.id)).status).toBe(403);
    expect((await rowOf(target, row.id))!.deleted_at).toBeNull();
    expect((await rowOf(target, row.id))!.credential_ciphertext).toBe('sealed');
  });

  test('消した接続をもう一度消す、別の組織の接続を消すのは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const row = await connectionOf(target, target.member);
    const other = await connectionOf(foreign, foreign.member);

    expect((await call(connectionDelete, target, target.member, row.id)).status).toBe(200);
    expect((await call(connectionDelete, target, target.member, row.id)).status).toBe(404);
    expect((await call(connectionDelete, target, target.admin, other.id)).status).toBe(404);
    expect((await rowOf(foreign, other.id))!.deleted_at).toBeNull();
  });

  test('閉じたワークスペースでは 409。接続は消えない', async () => {
    const target = await createTarget({ closed: true });
    const row = await connectionOf(target, target.member);

    expect((await call(connectionDelete, target, target.admin, row.id)).status).toBe(409);
    expect((await rowOf(target, row.id))!.deleted_at).toBeNull();
  });
});

describe('他のメンバーの接続の範囲', () => {
  test('リーダーと管理者は範囲を直せない（403）', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member);

    for (const caller of [target.leader, target.admin]) {
      const res = await post(app, connectionScopesSave, {
        slug: target.slug,
        token: caller.token,
        body: { workspace_id: target.workspace.id, connection_id: row.id, source_ids: [] },
      });
      expect(res.status).toBe(403);
    }
  });
});

describe('読んだ後に権限を失った操作', () => {
  // 接続を読んだ直後に、呼んだリーダーをメンバーへ下げる（書く文の条件が偽になる）
  function demoteLeaderAfterRead(target: Target): Env {
    return afterFirstQuery(
      env,
      (sql) => sql.includes('from "connections"') && sql.includes('"owner_user_id"'),
      async () => {
        const db = orgDb(env, target.organization.verified);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('memberships')
              .set({ role: 'member' })
              .where('user_id', '=', target.leader.userId!)
              .where('workspace_id', '=', target.workspace.id),
          ),
        );
      },
    );
  }

  test('再開できる理由で止まった接続の停止は、書けなかったときに 403。理由も履歴も変わらない', async () => {
    const target = await createTarget();
    const row = await connectionOf(target, target.member, { status: 'stopped', stopped_reason: 'auth_failed' });

    const res = await call(connectionStop, target, target.leader, row.id, demoteLeaderAfterRead(target));
    expect(res.status).toBe(403);
    expect(await rowOf(target, row.id)).toMatchObject({ stopped_reason: 'auth_failed' });
    expect(await logsOf(target, row.id)).toEqual([]);
  });

  test('止まっていない接続の停止と削除も、権限を失っていれば 403 で何も書かない', async () => {
    const target = await createTarget();
    const stop = await connectionOf(target, target.member);
    const remove = await connectionOf(target, target.member);

    expect((await call(connectionStop, target, target.leader, stop.id, demoteLeaderAfterRead(target))).status).toBe(
      403,
    );
    expect((await call(connectionDelete, target, target.leader, remove.id, demoteLeaderAfterRead(target))).status).toBe(
      403,
    );
    expect(await rowOf(target, stop.id)).toMatchObject({ status: 'active' });
    expect((await rowOf(target, remove.id))!.deleted_at).toBeNull();
    expect(await logsOf(target, stop.id)).toEqual([]);
    expect(await logsOf(target, remove.id)).toEqual([]);
  });
});
