// エピックのクリアと取り消し（epic-complete、epic-reopen）の振る舞い（競合、変更の履歴）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { epicComplete, epicDelete, epicReopen } from '../src/shared/operations/epic/index.ts';
import { storyComplete, storyMove } from '../src/shared/operations/story/index.ts';
import { taskComplete } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { deleteStatements } from '../src/server/operations/tree-delete.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createEpic, createStory, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// 開発用の時計（DEV_NOW）で時刻を止めた、ループバックの公開 URL の環境
function clockAt(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function clear(target: Target, epicId: string, person: Person = target.leader, requestEnv: Env = testEnv) {
  return post(app, epicComplete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId },
    env: requestEnv,
  });
}

function reopen(target: Target, epicId: string, person: Person = target.leader, requestEnv: Env = testEnv) {
  return post(app, epicReopen, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId },
    env: requestEnv,
  });
}

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

// 読んでから書くまでに別の要求が割り込んだ状況を作る。match に当たる batch() が答えた直後に、一度だけ change を流す
function racing(match: (sqls: readonly string[]) => boolean, change: () => Promise<void>): Env {
  let done = false;
  return envWithD1Hooks(testEnv, {
    afterBatch: async (sqls) => {
      if (done || !match(sqls)) return;
      done = true;
      await change();
    },
  });
}

// クリアする前の状態の読み取り（エピック、配下の件数）
const readsEpic = (sqls: readonly string[]) => sqls[0]?.startsWith('select "epics"."requester_user_id"') === true;

function epicOf(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  return createEpic(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

// 配下のストーリー。既定は完了済み
function storyUnder(target: Target, epicId: string, overrides: Parameters<typeof createStory>[3] = {}) {
  return createStory(target.organization, target.workspace.id, target.admin.userId!, {
    epic_id: epicId,
    completed_at: AT,
    completed_by: target.admin.userId!,
    ...overrides,
  });
}

async function epicRow(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return (await db.first(
    db.statement((q) =>
      q.selectFrom('epics').selectAll().where('id', '=', epicId).where('workspace_id', '=', target.workspace.id),
    ),
  ))!;
}

async function logsOf(target: Target, epicId: string) {
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
    changes: JSON.parse(row.changes_json) as unknown,
  }));
}

// 配下が完了したストーリー1件のエピック
async function readyEpic(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  const epic = await epicOf(target, overrides);
  await storyUnder(target, epic.id);
  return epic;
}

describe('epic-complete', () => {
  test('クリアして、完了の記録と変更の履歴を残す（応答は epic_id と completed_at だけ）', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);

    const res = await clear(target, epic.id, target.leader);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { epic_id: string; completed_at: string };
    expect(body).toEqual({ epic_id: epic.id, completed_at: expect.any(String) });

    const row = await epicRow(target, epic.id);
    expect(row.completed_at).toBe(body.completed_at);
    expect(row.completed_by).toBe(target.leader.userId);
    const logs = await logsOf(target, epic.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: target.leader.userId, action: 'complete' });
  });

  test('タスクとストーリーを完了の操作で完了にしてから、エピックをクリアできる', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    const story = await storyUnder(target, epic.id, { completed_at: null, completed_by: null });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      points: 2,
      assignee_user_id: target.leader.userId,
    });
    const completeTask = await post(app, taskComplete, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, task_id: task.id },
    });
    expect(completeTask.status).toBe(200);
    const completeStory = await post(app, storyComplete, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, story_id: story.id },
    });
    expect(completeStory.status).toBe(200);

    const res = await clear(target, epic.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epic_id: epic.id, completed_at: expect.any(String) });
    expect((await epicRow(target, epic.id)).completed_at).not.toBeNull();
  });

  test('依頼主は一般のメンバーでもクリアできる。依頼主でもリーダーでもないメンバーは 403 で、何も書かない', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target, { requester_user_id: target.leader.userId! });
    const denied = await clear(target, epic.id, target.member);
    expect(denied.status).toBe(403);
    expect((await epicRow(target, epic.id)).completed_at).toBeNull();
    expect(await logsOf(target, epic.id)).toEqual([]);

    const own = await readyEpic(target, { requester_user_id: target.member.userId! });
    expect((await clear(target, own.id, target.member)).status).toBe(200);
  });

  test('未完了のストーリーが残っていれば 409 の conflict（open_stories）、削除したストーリーは数えない', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const open = await storyUnder(target, epic.id, { completed_at: null, completed_by: null });
    const res = await clear(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_stories' });
    expect((await epicRow(target, epic.id)).completed_at).toBeNull();
    expect(await logsOf(target, epic.id)).toEqual([]);

    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ deleted_at: AT })
          .where('id', '=', open.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await clear(target, epic.id)).status).toBe(200);
  });

  test('配下に削除していないストーリーが1件も無ければ 409 の conflict（empty）', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    const res = await clear(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'empty' });
  });

  test('すでにクリアしていれば 409 の conflict（completed）', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    const again = await clear(target, epic.id);
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toEqual({ code: 'conflict', reason: 'completed' });
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const epic = await readyEpic(target);
    const res = await clear(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'workspace_closed', reason: undefined });
    expect((await epicRow(target, epic.id)).completed_at).toBeNull();
  });

  test('別の組織・別のワークスペースのエピックと存在しない ID は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await readyEpic(other);
    expect((await clear(target, foreign.id)).status).toBe(404);
    expect((await clear(target, '0198a3b4-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await epicRow(other, foreign.id)).completed_at).toBeNull();
  });

  test('止めた時計で同時に2回クリアしても、記録は1回分', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    const results = await Promise.all([
      clear(target, epic.id, target.leader, frozen),
      clear(target, epic.id, target.leader, frozen),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await logsOf(target, epic.id)).toHaveLength(1);
  });

  test('2つの画面から同時にクリアすると、片方は 409 の conflict（completed）で、記録は1回分', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    let second: Response | undefined;
    const raced = racing(readsEpic, async () => {
      second = await clear(target, epic.id, target.admin);
    });
    const first = await clear(target, epic.id, target.leader, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'completed' });
    expect((await epicRow(target, epic.id)).completed_by).toBe(target.admin.userId);
    expect(await logsOf(target, epic.id)).toHaveLength(1);
  });

  test('読んでから書くまでに未完了のストーリーが足されたら、何も書かず 409 の conflict（open_stories）', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const raced = racing(readsEpic, async () => {
      await storyUnder(target, epic.id, { completed_at: null, completed_by: null });
    });
    const res = await clear(target, epic.id, target.leader, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_stories' });
    expect(await logsOf(target, epic.id)).toEqual([]);
  });

  test('クリアしたエピックからも、ストーリーを移し出せない（同じストーリーで別のエピックをもう一度クリアできてしまうため）', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const story = await storyUnder(target, epic.id, { position: 'a1' });
    expect((await clear(target, epic.id)).status).toBe(200);
    const other = await epicOf(target);
    for (const destination of [other.id, null]) {
      const res = await post(app, storyMove, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, story_id: story.id, epic_id: destination },
        env: testEnv,
      });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({ code: 'conflict', reason: 'parent_completed' });
    }
  });

  test('クリア済みのエピックを、配下を残して削除できない（親なしになった完了済みのストーリーで、もう一度クリアできてしまうため）', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const story = await storyUnder(target, epic.id, { position: 'a1' });
    expect((await clear(target, epic.id)).status).toBe(200);
    const remove = (epicId: string, children: 'keep' | 'delete') =>
      post(app, epicDelete, {
        slug: target.slug,
        token: target.leader.token,
        body: { workspace_id: target.workspace.id, epic_id: epicId, children },
        env: testEnv,
      });
    const keep = await remove(epic.id, 'keep');
    expect(keep.status).toBe(409);
    expect(await errorOf(keep)).toEqual({ code: 'epic_finished', reason: undefined });
    expect((await epicRow(target, epic.id)).deleted_at).toBeNull();
    const db = orgDb(env, target.organization.verified);
    const still = await db.first(
      db.statement((q) => q.selectFrom('stories').select('epic_id').where('id', '=', story.id)),
    );
    expect(still?.epic_id).toBe(epic.id);
    // まとめて削除は通り、クリアしていないエピックの keep も通る
    expect((await remove(epic.id, 'delete')).status).toBe(200);
    const open = await epicOf(target);
    expect((await remove(open.id, 'keep')).status).toBe(200);
  });

  test('配下の無いクリア済みのエピックは、配下を残す削除でも通る', async () => {
    const target = await createTarget();
    const epic = await epicOf(target, { completed_at: AT, completed_by: target.admin.userId! });
    const res = await post(app, epicDelete, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, epic_id: epic.id, children: 'keep' },
      env: testEnv,
    });
    expect(res.status).toBe(200);
  });

  test('クリア後に配下のストーリーを削除したエピックは、配下を残す削除が通り、削除の印と履歴が残る', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const deleted = await storyUnder(target, epic.id, { position: 'a1', deleted_at: AT });
    expect((await clear(target, epic.id)).status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    // 削除済みのストーリーは配下に数えない。生きたストーリーも全部削除した状態にする
    await db.run(
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ deleted_at: AT })
          .where('epic_id', '=', epic.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(deleted.deleted_at).toBe(AT);
    const res = await post(app, epicDelete, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, epic_id: epic.id, children: 'keep' },
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect((await epicRow(target, epic.id)).deleted_at).not.toBeNull();
    expect((await logsOf(target, epic.id)).map((log) => log.action)).toEqual(['complete', 'delete']);
  });

  test('書く文の条件: 読んだ後にクリアされたエピックは、配下を残す削除の文が行を変えない', async () => {
    const target = await createTarget();
    const epic = await epicOf(target, { completed_at: AT, completed_by: target.admin.userId! });
    const story = await storyUnder(target, epic.id);
    const db = orgDb(env, target.organization.verified);
    const context = {
      organizationId: target.organization.id,
      workspaceId: target.workspace.id,
      actorUserId: target.leader.userId!,
      at: new Date(AT),
      deletedAt: AT,
      ownerOnly: null,
      forbidCleared: true,
    };
    const { statements, rootIndex } = deleteStatements(db, context, { kind: 'epic', id: epic.id }, 'keep');
    const results = await db.batch(statements);
    expect(results[rootIndex]?.changes ?? 0).toBe(0);
    expect((await epicRow(target, epic.id)).deleted_at).toBeNull();
    const still = await db.first(
      db.statement((q) => q.selectFrom('stories').select('epic_id').where('id', '=', story.id)),
    );
    expect(still?.epic_id).toBe(epic.id);
    // 同じ文でも、forbidCleared を付けなければ通る（クリアしていないエピックの keep と同じ）
    const open = deleteStatements(db, { ...context, forbidCleared: false }, { kind: 'epic', id: epic.id }, 'keep');
    const opened = await db.batch(open.statements);
    expect(opened[open.rootIndex]?.changes ?? 0).toBeGreaterThan(0);
  });

  test('クリアしたエピックの下へは、ストーリーを移せない', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    const loose = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const res = await post(app, storyMove, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, story_id: loose.id, epic_id: epic.id },
      env: testEnv,
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: 'conflict', reason: 'parent_completed' });
  });
});

describe('epic-reopen', () => {
  test('クリアを取り消すと、もう一度クリアできる', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    const firstRow = await epicRow(target, epic.id);

    const res = await reopen(target, epic.id, target.leader);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epic_id: epic.id });
    const reopened = await epicRow(target, epic.id);
    expect(reopened.completed_at).toBeNull();
    expect(reopened.completed_by).toBeNull();

    // もう一度クリアできる
    const again = await clear(target, epic.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ epic_id: epic.id });
    expect((await epicRow(target, epic.id)).completed_at).not.toBe(firstRow.completed_at);

    const actions = (await logsOf(target, epic.id)).map((log) => log.action);
    expect(actions).toEqual(['complete', 'reopen', 'complete']);
    expect((await logsOf(target, epic.id))[1]!.changes).toEqual({
      completed_at: [firstRow.completed_at, null],
      completed_by: [{ id: target.leader.userId, name: expect.any(String) }, null],
    });
  });

  test('止めた時計で、クリア、取り消し、クリアを同じ時刻に流しても落ちない', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    expect((await clear(target, epic.id, target.leader, frozen)).status).toBe(200);
    expect((await reopen(target, epic.id, target.leader, frozen)).status).toBe(200);
    const again = await clear(target, epic.id, target.leader, frozen);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ epic_id: epic.id });
    expect((await epicRow(target, epic.id)).completed_at).toBe('2026-10-26T01:00:00.000Z');
  });

  test('クリアと取り消しを2回ずつ流せる', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    for (let round = 0; round < 2; round++) {
      expect((await clear(target, epic.id)).status).toBe(200);
      expect((await reopen(target, epic.id)).status).toBe(200);
    }
    expect((await logsOf(target, epic.id)).map((log) => log.action)).toEqual([
      'complete',
      'reopen',
      'complete',
      'reopen',
    ]);
  });

  test('クリアしていなければ 409 の conflict（not_completed）', async () => {
    const target = await createTarget();
    const open = await readyEpic(target);
    const res = await reopen(target, open.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'not_completed' });
  });

  test('依頼主かリーダーでなければ 403 で、何も書かない。依頼主は取り消せる', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target, { requester_user_id: target.leader.userId! });
    expect((await clear(target, epic.id)).status).toBe(200);
    expect((await reopen(target, epic.id, target.member)).status).toBe(403);
    expect((await epicRow(target, epic.id)).completed_at).not.toBeNull();

    const own = await readyEpic(target, { requester_user_id: target.member.userId! });
    expect((await clear(target, own.id, target.member)).status).toBe(200);
    expect((await reopen(target, own.id, target.member)).status).toBe(200);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const epic = await readyEpic(target, { completed_at: AT, completed_by: target.admin.userId! });
    const res = await reopen(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'workspace_closed', reason: undefined });
    expect((await epicRow(target, epic.id)).completed_at).toBe(AT);
  });

  test('2つの画面から同時に取り消すと、片方は 409 の conflict（not_completed）で、履歴は1回分', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    let second: Response | undefined;
    const raced = racing(readsEpic, async () => {
      second = await reopen(target, epic.id, target.admin);
    });
    const first = await reopen(target, epic.id, target.leader, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'not_completed' });
    expect((await logsOf(target, epic.id)).map((log) => log.action)).toEqual(['complete', 'reopen']);
  });

  test('別の組織のエピックと存在しない ID は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await readyEpic(other, { completed_at: AT, completed_by: other.admin.userId! });
    expect((await reopen(target, foreign.id)).status).toBe(404);
    expect((await reopen(target, '0198a3b4-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await epicRow(other, foreign.id)).completed_at).toBe(AT);
  });
});
