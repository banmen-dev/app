// 依頼主の変更（epic-requester-update）と、epic-detail の can_change_requester の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { epicDetail, epicRequesterUpdate } from '../src/shared/operations/epic/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace, type OrganizationDb } from '../src/server/db/index.ts';
import { epicRequesterUpdateOperation } from '../src/server/operations/epic-requester.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createEpic, createMembership, createUser, hash64 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function call(definition: AnyOperationDefinition, target: Target, person: Person, body: Record<string, unknown>) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: testEnv,
  });
}

const requester = (target: Target, epicId: string, userId: string, person: Person = target.leader) =>
  call(epicRequesterUpdate, target, person, { epic_id: epicId, user_id: userId });

async function rename(target: Target, person: Person, name: string) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ name })
        .where('id', '=', person.userId!)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// 名前で見分けられるように、メンバーとリーダーと管理者に別の名前を付けた対象
async function namedTarget(options: { closed?: boolean } = {}) {
  const target = await createTarget(options);
  await rename(target, target.member, '若葉 湊');
  await rename(target, target.leader, '朝霧 楓');
  await rename(target, target.admin, '白波 渚');
  return target;
}

function epicOf(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  return createEpic(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

async function rowOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select(['requester_user_id', 'updated_at'])
        .where('id', '=', epicId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
  return row!;
}

async function epicLogsOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'epic')
        .where('entity_id', '=', epicId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({
    actor: row.actor_user_id,
    action: row.action,
    workspace_id: row.workspace_id,
    changes: JSON.parse(row.changes_json) as unknown,
  }));
}

const finishedEpics = {
  クリア: { completed_at: '2026-10-22T00:00:00.000Z' },
  中止: { canceled_at: '2026-10-22T00:00:00.000Z' },
} as const;

function finishedOf(target: Target) {
  return { completed_at: '2026-10-22T00:00:00.000Z', completed_by: target.admin.userId! };
}

function finishedOverrides(label: string, target: Target) {
  const overrides = finishedEpics[label as keyof typeof finishedEpics];
  return { ...overrides, [label === 'クリア' ? 'completed_by' : 'canceled_by']: target.admin.userId! };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await errorCodeOf(res)).toBe(code);
}

// 書く文の batch() の直前に、別の要求が先に書いた、という状態を作って処理を直に呼ぶ。
// 読み取りは db.first（batch() を通らない）なので、処理が呼ぶ最初の batch() が書く文になる。before は何回目の書き込みかを受ける
async function runRacing(
  operation: typeof epicRequesterUpdateOperation,
  target: Target,
  person: Person,
  input: Record<string, unknown>,
  before: (attempt: number, db: OrganizationDb) => Promise<void>,
) {
  const db = orgDb(env, target.organization.verified);
  const actor = { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let attempts = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'batch') return value.bind(base);
      return async (...args: unknown[]) => {
        await before(attempts++, db);
        return (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
      };
    },
  });
  const context = {
    db: racing,
    actor,
    workspace,
    input: { workspace_id: target.workspace.id, ...input },
    defer: () => {},
  } as never;
  return (operation.handler as (context: never) => Promise<unknown>)(context);
}

function closeWorkspace(db: OrganizationDb, target: Target) {
  return db.run(
    db.statement((q) => q.updateTable('workspaces').set({ closed_at: AT }).where('id', '=', target.workspace.id)),
  );
}

function setEpic(db: OrganizationDb, target: Target, epicId: string, set: Record<string, unknown>) {
  return db.run(
    db.statement((q) =>
      q.updateTable('epics').set(set).where('id', '=', epicId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

describe('epic-requester-update', () => {
  test('リーダーは今所属している人に替えられ、前後の依頼主の名前を履歴に残す。updated_at も更新する', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const res = await requester(target, epic.id, target.member.userId!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: true,
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
    });
    const row = await rowOf(target, epic.id);
    expect(row.requester_user_id).toBe(target.member.userId);
    expect(row.updated_at).not.toBe(AT);
    expect(await epicLogsOf(target, epic.id)).toEqual([
      {
        actor: target.leader.userId,
        action: 'update',
        workspace_id: target.workspace.id,
        changes: {
          requester: [
            { id: target.admin.userId, name: '白波 渚' },
            { id: target.member.userId, name: '若葉 湊' },
          ],
        },
      },
    ]);
  });

  test('管理者（ワークスペースに所属していなくても）も替えられる', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    expect((await requester(target, epic.id, target.leader.userId!, target.admin)).status).toBe(200);
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.leader.userId);
  });

  test('依頼主本人も、一般のメンバーも、所属していない人も 403 の forbidden で、何も書かない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    for (const person of [target.member, target.bystander]) {
      await expectError(await requester(target, epic.id, target.leader.userId!, person), 403, 'forbidden');
    }
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.member.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('依頼主が離れたレイドで、リーダーは依頼主を替えられる', async () => {
    const target = await namedTarget();
    const gone = await createUser(target.organization, { name: '離れた 人' });
    await createMembership(target.organization, target.workspace.id, gone.id, { left_at: AT, left_on: '2026-10-20' });
    const epic = await epicOf(target, { requester_user_id: gone.id });
    expect((await requester(target, epic.id, target.member.userId!)).status).toBe(200);
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.member.userId);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      {
        requester: [
          { id: gone.id, name: '離れた 人' },
          { id: target.member.userId, name: '若葉 湊' },
        ],
      },
    ]);
  });

  test('今と同じ依頼主は 200 の changed: false で、何も書かず、履歴も残さない', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    const res = await requester(target, epic.id, target.member.userId!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: false,
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
    });
    expect((await rowOf(target, epic.id)).updated_at).toBe(AT);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('所属していない管理者が依頼主のレイドで、その管理者を替え先にすると 404', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expectError(await requester(target, epic.id, target.admin.userId!), 404, 'not_found');
  });

  test('所属していない人、抜けた人、無効の人、login_subject の無い人、別の組織の人は 404', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const epic = await epicOf(target);
    const gone = await createUser(target.organization, { name: '離れた 人' });
    await createMembership(target.organization, target.workspace.id, gone.id, { left_at: AT, left_on: '2026-10-20' });
    const disabled = await createPerson({
      organization: target.organization,
      disabled: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const pending = await createUser(target.organization, {
      login_provider: 'google',
      login_subject: null,
      login_email: 'waiting@example.test',
      claim_token_hash: hash64(),
      claim_expires_at: '2999-01-01T00:00:00.000Z',
    });
    await createMembership(target.organization, target.workspace.id, pending.id);
    const ids = [
      target.bystander.userId!,
      gone.id,
      disabled.userId!,
      pending.id,
      foreign.member.userId!,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) await expectError(await requester(target, epic.id, id), 404, 'not_found');
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  for (const label of Object.keys(finishedEpics)) {
    test(`${label}したエピックの依頼主は替えられない（409 の epic_finished）`, async () => {
      const target = await namedTarget();
      const epic = await epicOf(target, finishedOverrides(label, target));
      await expectError(await requester(target, epic.id, target.member.userId!), 409, 'epic_finished');
      expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
      expect(await epicLogsOf(target, epic.id)).toEqual([]);
    });
  }

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは 404', async () => {
    const target = await namedTarget();
    const foreign = await createTarget();
    const ids = [
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!)).id,
      // 終わったエピックでも、別の組織・別のワークスペースのものは 409 でなく 404
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!, finishedOf(foreign))).id,
      (await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!, finishedOf(target))).id,
      (await epicOf(target, { deleted_at: '2026-10-21T00:00:00.000Z' })).id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) await expectError(await requester(target, id, target.member.userId!), 404, 'not_found');
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const target = await namedTarget({ closed: true });
    const epic = await epicOf(target);
    await expectError(await requester(target, epic.id, target.member.userId!), 409, 'workspace_closed');
  });

  test('読んだ後に別の要求が先に依頼主を替えたら、読み直して、替えた後の依頼主から書く', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const result = await runRacing(
      epicRequesterUpdateOperation,
      target,
      target.leader,
      { epic_id: epic.id, user_id: target.member.userId! },
      async (attempt, db) => {
        if (attempt === 0) await setEpic(db, target, epic.id, { requester_user_id: target.leader.userId! });
      },
    );
    expect(result).toEqual({
      changed: true,
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
    });
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.member.userId);
    expect((await epicLogsOf(target, epic.id)).map((log) => log.changes)).toEqual([
      {
        requester: [
          { id: target.leader.userId, name: '朝霧 楓' },
          { id: target.member.userId, name: '若葉 湊' },
        ],
      },
    ]);
  });

  test('読んだ後にワークスペースが閉じられたら、書く文の条件で止まり、読み直して 409 の workspace_closed', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expect(
      runRacing(
        epicRequesterUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, user_id: target.member.userId! },
        async (attempt, db) => {
          if (attempt === 0) await closeWorkspace(db, target);
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('読んだ後に替え先が所属を外れたら、書く文の条件で止まり、読み直して 404', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    await expect(
      runRacing(
        epicRequesterUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, user_id: target.member.userId! },
        async (attempt, db) => {
          if (attempt !== 0) return;
          await db.run(
            db.statement((q) =>
              q
                .updateTable('memberships')
                .set({ left_at: AT, left_on: '2026-10-20' })
                .where('workspace_id', '=', target.workspace.id)
                .where('user_id', '=', target.member.userId!),
            ),
          );
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('負け続けたら 3 回で諦めて 409 の conflict', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const others = [target.leader.userId!, target.admin.userId!];
    await expect(
      runRacing(
        epicRequesterUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, user_id: target.member.userId! },
        async (attempt, db) => {
          await setEpic(db, target, epic.id, { requester_user_id: others[attempt % 2]! });
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });

  test('2 回負けた後の最後の書き込みの直前にエピックが終わったら、409 の epic_finished（conflict ではない）', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    const others = [target.leader.userId!, target.admin.userId!];
    await expect(
      runRacing(
        epicRequesterUpdateOperation,
        target,
        target.leader,
        { epic_id: epic.id, user_id: target.member.userId! },
        async (attempt, db) => {
          if (attempt < 2) await setEpic(db, target, epic.id, { requester_user_id: others[attempt % 2]! });
          else await setEpic(db, target, epic.id, { completed_at: AT, completed_by: target.admin.userId! });
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'epic_finished' });
    expect((await rowOf(target, epic.id)).requester_user_id).toBe(target.admin.userId);
    expect(await epicLogsOf(target, epic.id)).toEqual([]);
  });
});

describe('epic-detail の can_change_requester', () => {
  async function detailOf(target: Target, epicId: string, person: Person) {
    const res = await call(epicDetail, target, person, { epic_id: epicId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { can_manage: boolean; can_change_requester: boolean };
    return { can_manage: body.can_manage, can_change_requester: body.can_change_requester };
  }

  test('リーダーと管理者は真。依頼主の一般のメンバーは can_manage だけ真', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target, { requester_user_id: target.member.userId! });
    expect(await detailOf(target, epic.id, target.leader)).toEqual({ can_manage: true, can_change_requester: true });
    expect(await detailOf(target, epic.id, target.admin)).toEqual({ can_manage: true, can_change_requester: true });
    expect(await detailOf(target, epic.id, target.member)).toEqual({ can_manage: true, can_change_requester: false });
  });

  test('依頼主でもリーダーでもない一般のメンバーはどちらも偽', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    expect(await detailOf(target, epic.id, target.member)).toEqual({ can_manage: false, can_change_requester: false });
  });

  test('替えた後の epic-detail は、新しい依頼主を返す', async () => {
    const target = await namedTarget();
    const epic = await epicOf(target);
    expect((await requester(target, epic.id, target.member.userId!)).status).toBe(200);
    const res = await call(epicDetail, target, target.leader, { epic_id: epic.id });
    expect(await res.json()).toMatchObject({
      requester: { id: target.member.userId, name: '若葉 湊', left: false },
    });
  });
});
