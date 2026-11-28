// ストーリーの完了と取り消しの振る舞い（競合、変更の履歴）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { storyComplete, storyReopen } from '../src/shared/operations/story/index.ts';
import { taskComplete } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createEpic, createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// 開発用の時計（DEV_NOW）で時刻を止めた、ループバックの公開 URL の環境
function clockAt(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function complete(target: Target, storyId: string, person: Person = target.member, requestEnv: Env = testEnv) {
  return post(app, storyComplete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId },
    env: requestEnv,
  });
}

function reopen(target: Target, storyId: string, person: Person = target.member, requestEnv: Env = testEnv) {
  return post(app, storyReopen, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId },
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

// 完了にする前の状態の読み取り（ストーリー、未完了の件数）
const readsCompletion = (sqls: readonly string[]) =>
  sqls[0]?.startsWith(
    'select "stories"."id", "stories"."completed_at", "epics"."completed_at" as "epic_completed_at"',
  ) === true;

async function storyRow(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('stories').selectAll().where('id', '=', storyId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function logsOf(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'story')
        .where('entity_id', '=', storyId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

// 完了したタスク
function completedTask(target: Target, storyId: string, userId: string, options: { deleted?: boolean } = {}) {
  return createTask(target.organization, target.workspace.id, target.admin.userId!, {
    story_id: storyId,
    points: 3,
    assignee_user_id: userId,
    completed_at: AT,
    completed_by: userId,
    deleted_at: options.deleted ? AT : null,
  });
}

function emptyStory(target: Target, overrides: Parameters<typeof createStory>[3] = {}) {
  return createStory(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

describe('story-complete', () => {
  test('完了にして、完了した日時と人と変更の履歴を残す', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const member = target.member.userId!;
    await completedTask(target, story.id, member);
    await completedTask(target, story.id, member);
    await completedTask(target, story.id, target.leader.userId!);
    await completedTask(target, story.id, target.admin.userId!, { deleted: true });

    const res = await complete(target, story.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { story_id: string; completed_at: string };
    expect(body.story_id).toBe(story.id);
    expect(await storyRow(target, story.id)).toMatchObject({
      completed_at: body.completed_at,
      completed_by: member,
      updated_at: body.completed_at,
    });

    const logs = await logsOf(target, story.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'complete', actor_user_id: member, created_at: body.completed_at });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      completed_at: [null, body.completed_at],
      completed_by: [null, { id: member, name: '星野 澪' }],
    });
  });

  test('配下のタスクを完了の操作で完了にしてから完了にできる', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const assigned = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      points: 2,
      assignee_user_id: target.leader.userId,
    });
    const unassigned = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      points: 1,
    });
    for (const task of [assigned, unassigned]) {
      const res = await post(app, taskComplete, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, task_id: task.id },
      });
      expect(res.status).toBe(200);
    }
    expect((await complete(target, story.id)).status).toBe(200);
  });

  test('配下にタスクが1件も無いストーリーも完了にできる', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    expect((await complete(target, story.id)).status).toBe(200);
    expect((await storyRow(target, story.id))!.completed_at).not.toBeNull();
    expect(await logsOf(target, story.id)).toHaveLength(1);
  });

  test('配下に未完了のタスクが残っていれば 409 の conflict（open_tasks）で、何も書かない', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    await createTask(target.organization, target.workspace.id, target.admin.userId!, { story_id: story.id });
    const res = await complete(target, story.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_tasks' });
    expect((await storyRow(target, story.id))!.completed_at).toBeNull();
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('削除した未完了のタスクと、別のストーリーの未完了のタスクは、残りに数えない', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const other = await emptyStory(target);
    await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
      deleted_at: AT,
    });
    await createTask(target.organization, target.workspace.id, target.admin.userId!, { story_id: other.id });
    expect((await complete(target, story.id)).status).toBe(200);
  });

  test('親のエピックが完了していれば 409 の conflict（parent_completed）で、何も書かない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    for (const overrides of [{ completed_at: AT, completed_by: adminId }]) {
      const epic = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const story = await emptyStory(target, { epic_id: epic.id });
      await completedTask(target, story.id, target.member.userId!);
      const res = await complete(target, story.id);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
      expect((await storyRow(target, story.id))!.completed_at).toBeNull();
      expect(await logsOf(target, story.id)).toEqual([]);
    }
    // 開いているエピックと、削除したエピックの下なら完了にできる
    for (const overrides of [{}, { completed_at: AT, completed_by: adminId, deleted_at: AT }]) {
      const epic = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const story = await emptyStory(target, { epic_id: epic.id });
      expect((await complete(target, story.id)).status).toBe(200);
    }
  });

  test('読んでから書くまでに親のエピックが完了したら、何も書かず 409 の conflict（parent_completed）', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const story = await emptyStory(target, { epic_id: epic.id });
    const raced = racing(readsCompletion, async () => {
      const db = orgDb(env, target.organization.verified);
      await db.run(
        db.statement((q) =>
          q
            .updateTable('epics')
            .set({ completed_at: AT, completed_by: adminId })
            .where('id', '=', epic.id)
            .where('workspace_id', '=', target.workspace.id),
        ),
      );
    });
    const res = await complete(target, story.id, target.member, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
    expect((await storyRow(target, story.id))!.completed_at).toBeNull();
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('すでに完了していれば 409 の conflict（completed）', async () => {
    const target = await createTarget();
    const story = await emptyStory(target, { completed_at: AT, completed_by: target.admin.userId! });
    const res = await complete(target, story.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'completed' });
  });

  test('2つの画面から同時に完了にすると、片方は 409 の conflict で、記録は1回分', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    await completedTask(target, story.id, target.leader.userId!);
    // 1つ目の要求が読んだ直後に、2つ目の要求が先に完了にする
    let second: Response | undefined;
    const raced = racing(readsCompletion, async () => {
      second = await complete(target, story.id, target.leader);
    });
    const first = await complete(target, story.id, target.member, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'completed' });
    expect((await storyRow(target, story.id))!.completed_by).toBe(target.leader.userId);
    expect(await logsOf(target, story.id)).toHaveLength(1);
  });

  test('止めた時計で同じ人が2回完了にしても、記録は1回分', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    const results = await Promise.all([
      complete(target, story.id, target.member, frozen),
      complete(target, story.id, target.member, frozen),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await logsOf(target, story.id)).toHaveLength(1);
  });

  test('読んでから書くまでに配下のタスクが足されたら、何も書かず 409 の conflict（open_tasks）', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const raced = racing(readsCompletion, async () => {
      await createTask(target.organization, target.workspace.id, target.admin.userId!, { story_id: story.id });
    });
    const res = await complete(target, story.id, target.member, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_tasks' });
    expect((await storyRow(target, story.id))!.completed_at).toBeNull();
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないストーリーは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const ids = [
      (await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createStory(target.organization, target.otherWorkspace.id, target.admin.userId!)).id,
      (await emptyStory(target, { deleted_at: AT })).id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) {
      for (const res of [await complete(target, id), await reopen(target, id)]) {
        expect(res.status, id).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    }
    expect((await storyRow(foreign, ids[0]!))!.completed_at).toBeNull();
  });

  test('閉じたワークスペースでは 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const story = await emptyStory(target);
    const res = await complete(target, story.id, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });
});

describe('story-reopen', () => {
  test('完了を取り消すと、もう一度完了にできる', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const member = target.member.userId!;
    const leader = target.leader.userId!;
    await completedTask(target, story.id, member);
    await completedTask(target, story.id, leader);
    const completing = await complete(target, story.id, target.member, clockAt('2026-10-26T01:00:00.000Z'));
    const first = (await completing.json()) as { completed_at: string };

    const res = await reopen(target, story.id, target.leader, clockAt('2026-10-26T02:00:00.000Z'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ story_id: story.id });
    expect(await storyRow(target, story.id)).toMatchObject({
      completed_at: null,
      completed_by: null,
      updated_at: '2026-10-26T02:00:00.000Z',
    });

    // もう一度完了にでき、もう一度取り消せる
    expect((await complete(target, story.id, target.member, clockAt('2026-10-26T03:00:00.000Z'))).status).toBe(200);
    expect((await storyRow(target, story.id))!.completed_at).toBe('2026-10-26T03:00:00.000Z');
    expect((await reopen(target, story.id, target.member, clockAt('2026-10-26T04:00:00.000Z'))).status).toBe(200);

    const logs = await logsOf(target, story.id);
    expect(logs.map((log) => log.action)).toEqual(['complete', 'reopen', 'complete', 'reopen']);
    expect(logs[1]).toMatchObject({ actor_user_id: leader });
    expect(JSON.parse(logs[1]!.changes_json)).toEqual({
      completed_at: [first.completed_at, null],
      completed_by: [{ id: member, name: '星野 澪' }, null],
    });
  });

  test('止めた時計で、完了、取り消し、完了を同じ時刻に流しても落ちない', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    expect((await complete(target, story.id, target.member, frozen)).status).toBe(200);
    expect((await reopen(target, story.id, target.member, frozen)).status).toBe(200);
    expect((await complete(target, story.id, target.member, frozen)).status).toBe(200);
    expect((await storyRow(target, story.id))!.completed_at).toBe('2026-10-26T01:00:00.000Z');
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const story = await emptyStory(target, { completed_at: AT, completed_by: target.admin.userId! });
    const res = await reopen(target, story.id, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect((await storyRow(target, story.id))!.completed_at).toBe(AT);
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('完了していなければ 409 の conflict（not_completed）', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    const res = await reopen(target, story.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'not_completed' });
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('親のエピックが完了していれば 409 の conflict（parent_completed）で、何も書かない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    for (const overrides of [{ completed_at: AT, completed_by: adminId }]) {
      const epic = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const story = await emptyStory(target, { epic_id: epic.id, completed_at: AT, completed_by: adminId });
      const res = await reopen(target, story.id);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'parent_completed' });
      expect((await storyRow(target, story.id))!.completed_at).toBe(AT);
    }
    // 開いているエピックの下なら取り消せる
    const open = await createEpic(target.organization, target.workspace.id, adminId);
    const openStory = await emptyStory(target, { epic_id: open.id, completed_at: AT, completed_by: adminId });
    expect((await reopen(target, openStory.id)).status).toBe(200);
    // 削除したエピックは親として数えない（クリアしてから削除したものも）。409 の changed にならずに取り消せる
    for (const overrides of [{ deleted_at: AT }, { completed_at: AT, completed_by: adminId, deleted_at: AT }]) {
      const deleted = await createEpic(target.organization, target.workspace.id, adminId, overrides);
      const under = await emptyStory(target, { epic_id: deleted.id, completed_at: AT, completed_by: adminId });
      const res = await reopen(target, under.id);
      expect(res.status).toBe(200);
      expect((await storyRow(target, under.id))!.completed_at).toBeNull();
    }
  });

  test('2つの画面から同時に取り消すと、片方は 409 の conflict（not_completed）で、履歴は1回分', async () => {
    const target = await createTarget();
    const story = await emptyStory(target);
    await completedTask(target, story.id, target.member.userId!);
    expect((await complete(target, story.id)).status).toBe(200);
    // 1つ目の要求が状態を読んだ直後に、2つ目の要求が先に取り消す
    let second: Response | undefined;
    let done = false;
    const raced = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !sql.startsWith('select "stories"."id", "stories"."epic_id", "stories"."completed_at"')) return;
        done = true;
        second = await reopen(target, story.id, target.leader);
      },
    });
    const first = await reopen(target, story.id, target.member, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'not_completed' });
    expect((await logsOf(target, story.id)).map((log) => log.action)).toEqual(['complete', 'reopen']);
  });
});
