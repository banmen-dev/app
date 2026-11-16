import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, readReviewTarget, reviewUpdateStatements } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { experienceSummary } from '../src/shared/operations/experience/index.ts';
import { taskComplete, taskReopen } from '../src/shared/operations/task/index.ts';
import {
  createConnection,
  createTask,
  createTaskSource,
  createDetailField,
  createTaskFieldValue,
  createThanks,
  createBoardColumn,
  createSprint,
  createSprintEntry,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const AT = '2026-11-01T00:00:00.000Z';
const clock: Env = Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: AT });

async function setup(
  options: {
    kind?: 'review_request' | 'pull_request';
    cycle?: string | null;
    points?: number | null;
    assignee?: 'leader' | 'admin' | null;
  } = {},
) {
  const target = await createTarget();
  const db = orgDb(env, target.organization.verified);
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
    is_imported: 1,
    created_by: null,
    points: options.points === undefined ? 2 : options.points,
    assignee_user_id: options.assignee ? target[options.assignee].userId! : null,
  });
  const connection = await createConnection(target.organization, target.workspace.id, target.member.userId!);
  const cycle = options.cycle === undefined ? 'request-1' : options.cycle;
  await createTaskSource(target.organization, target.workspace.id, task.id, connection.id, {
    source_kind: options.kind ?? 'review_request',
    reviewer_source_id: options.kind === 'pull_request' ? '' : 'reviewer-1',
    review_cycle: cycle,
  });
  if (cycle !== null) {
    await db.run(
      db.statement((q) =>
        q
          .insertInto('review_request_cycles')
          .values({ task_id: task.id, review_cycle: cycle, completion_id: null, created_at: AT }),
      ),
    );
  }
  return { target, db, task, connection };
}

function call(target: Target, taskId: string, definition: Parameters<typeof post>[1] = taskComplete) {
  return post(app, definition, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
    env: clock,
  });
}

async function grants(s: Awaited<ReturnType<typeof setup>>) {
  return s.db.rows(
    s.db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .selectAll()
        .where('workspace_id', '=', s.target.workspace.id)
        .where('task_id', '=', s.task.id)
        .orderBy('id'),
    ),
  );
}

async function completions(s: Awaited<ReturnType<typeof setup>>) {
  return s.db.rows(
    s.db.statement((q) =>
      q
        .selectFrom('completions')
        .selectAll()
        .where('workspace_id', '=', s.target.workspace.id)
        .where('task_id', '=', s.task.id)
        .orderBy('id'),
    ),
  );
}

// 実際の #1314 の保存口で照合し、再依頼なら受信箱へ戻す。
async function syncReview(s: Awaited<ReturnType<typeof setup>>, cycle: string, isDone: boolean) {
  const target = await readReviewTarget(s.db, s.connection, '1001', '');
  expect(target).toBeDefined();
  await s.db.batch(
    reviewUpdateStatements(
      s.db,
      s.connection,
      target!,
      {
        kind: 'review_request',
        sourceId: `node-${s.task.id}`,
        reviewerSourceId: 'reviewer-1',
        reviewCycle: cycle,
        key: 'aoba/shop#12',
        url: 'https://github.com/aoba/shop/pull/12',
        title: 'レビュー',
        containerId: '1001',
        containerName: 'aoba/shop',
        status: isDone ? 'closed' : 'open',
        dueOn: null,
        updatedAt: AT,
        isDone,
      },
      'a1',
      AT,
    ),
  );
}

async function nextCycle(s: Awaited<ReturnType<typeof setup>>) {
  await syncReview(s, 'request-2', false);
  // 受信箱からバックログに入れた後、人が完了できる。
  await s.db.run(
    s.db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ tray: 'backlog' })
        .where('workspace_id', '=', s.target.workspace.id)
        .where('id', '=', s.task.id),
    ),
  );
}

describe('レビュー依頼の回ごとの経験値', () => {
  test('提出・終了の同期検知は印だけを変え、完了記録と経験値を作らない', async () => {
    const s = await setup();
    await syncReview(s, 'request-1', true);
    expect(await completions(s)).toEqual([]);
    expect(await grants(s)).toEqual([]);
    const source = await s.db.first(
      s.db.statement((q) =>
        q
          .selectFrom('task_sources')
          .select('is_source_done')
          .where('workspace_id', '=', s.target.workspace.id)
          .where('task_id', '=', s.task.id),
      ),
    );
    expect(source?.is_source_done).toBe(1);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toMatchObject([{ action: 'review', amount: 30 }]);
  });

  test('人が完了した時だけ review を担当者へ付け、依頼回と完了を結ぶ', async () => {
    const s = await setup({ assignee: 'leader' });
    expect(await grants(s)).toEqual([]);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const rows = await grants(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'review', amount: 30, user_id: s.target.leader.userId });
    expect(rows[0].dedupe_key).toBe(`review:${rows[0].completion_id}`);
    const cycles = await s.db.rows(
      s.db.statement((q) => q.selectFrom('review_request_cycles').selectAll().where('task_id', '=', s.task.id)),
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].completion_id).toBe(rows[0].completion_id);
  });

  test('担当なしなら完了した人へ付け、同じ依頼回の再送と並行完了で二重に付けない', async () => {
    const s = await setup();
    const responses = await Promise.all([call(s.target, s.task.id), call(s.target, s.task.id)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call(s.target, s.task.id)).status).toBe(409);
    expect(await grants(s)).toMatchObject([{ action: 'review', amount: 30, user_id: s.target.member.userId }]);
    expect(await completions(s)).toHaveLength(1);
  });

  test.each([0, null])('ポイント %s は完了記録だけを作り、経験値を付けない', async (points) => {
    const s = await setup({ points });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toEqual([]);
    expect(await completions(s)).toHaveLength(1);
  });

  test('所属していない担当者には付けず、実行者への付け替えもしない', async () => {
    const s = await setup({ assignee: 'admin' });
    await s.db.run(
      s.db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: AT, left_on: '2026-11-01' })
          .where('workspace_id', '=', s.target.workspace.id)
          .where('user_id', '=', s.target.admin.userId!),
      ),
    );
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toEqual([]);
  });

  test('通常の取り消しは当該回を打ち消し、同じ回の再完了は正味1回分になる', async () => {
    const s = await setup();
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    expect(await completions(s)).toEqual([]);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const rows = await grants(s);
    expect(rows.every((r) => r.action === 'review')).toBe(true);
    expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(30);
    expect(await completions(s)).toHaveLength(1);
  });

  test('同じ時刻の再依頼後も過去を残し、次回の人の完了で付け、取り消しは次回だけ', async () => {
    const s = await setup();
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const first = (await completions(s))[0];
    await nextCycle(s);
    expect(await grants(s)).toHaveLength(1);
    expect(await completions(s)).toHaveLength(1);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await completions(s)).toHaveLength(2);
    expect((await grants(s)).filter((r) => r.action === 'review' && r.amount === 30)).toHaveLength(2);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    expect(await completions(s)).toMatchObject([{ id: first.id }]);
    expect((await grants(s)).reduce((sum, r) => sum + r.amount, 0)).toBe(30);
  });

  test('移行前の依頼回なしのレビュー依頼も通常完了XPに混ぜない', async () => {
    const s = await setup({ cycle: null });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toMatchObject([{ action: 'review', amount: 30 }]);
  });

  test('依頼回なしで完了した旧行を初回同期した後でも当該完了を取り消せる', async () => {
    const s = await setup({ cycle: null });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const first = (await completions(s))[0];
    await syncReview(s, 'request-1', true);
    expect(await completions(s)).toMatchObject([{ id: first.id }]);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    expect(await completions(s)).toEqual([]);
    expect((await grants(s)).reduce((sum, r) => sum + r.amount, 0)).toBe(0);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await completions(s)).toHaveLength(1);
    expect((await grants(s)).reduce((sum, r) => sum + r.amount, 0)).toBe(30);
  });

  test('旧未接続完了と現在回の完了が同時刻でも、現在回の取り消しは過去を残す', async () => {
    const s = await setup({ cycle: null });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const first = (await completions(s))[0];
    await syncReview(s, 'request-1', true);
    await nextCycle(s);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await completions(s)).toHaveLength(2);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    expect(await completions(s)).toMatchObject([{ id: first.id }]);
    expect((await grants(s)).reduce((sum, r) => sum + r.amount, 0)).toBe(30);
  });

  test('再依頼の同じ詳細と感謝には重ねて付けず、現在回の取消も過去の付与を残す', async () => {
    const s = await setup();
    const field = await createDetailField(s.target.organization, s.target.workspace.id);
    await createTaskFieldValue(s.target.organization, s.task.id, field.id, s.target.member.userId!);
    await createThanks(
      s.target.organization,
      s.target.workspace.id,
      s.task.id,
      s.target.leader.userId!,
      s.target.member.userId!,
    );
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const first = await grants(s);
    expect(first.filter((r) => r.action === 'task_detailed')).toMatchObject([{ amount: 20 }]);
    expect(first.filter((r) => r.action === 'help')).toMatchObject([{ amount: 10 }]);
    await nextCycle(s);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const second = await grants(s);
    expect(second.filter((r) => r.action === 'task_detailed')).toHaveLength(1);
    expect(second.filter((r) => r.action === 'help')).toHaveLength(1);
    expect(second.reduce((sum, r) => sum + r.amount, 0)).toBe(90);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    const reopened = await grants(s);
    expect(reopened.filter((r) => r.amount < 0)).toMatchObject([{ action: 'review', amount: -30 }]);
    expect(reopened.reduce((sum, r) => sum + r.amount, 0)).toBe(60);
  });

  test('前回の詳細経験値が残る再依頼では、次回の詳細見込みを数えない', async () => {
    const s = await setup();
    const field = await createDetailField(s.target.organization, s.target.workspace.id);
    await createTaskFieldValue(s.target.organization, s.task.id, field.id, s.target.member.userId!);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect((await grants(s)).filter((r) => r.action === 'task_detailed')).toMatchObject([{ amount: 20 }]);
    await nextCycle(s);
    const response = await post(app, experienceSummary, {
      slug: s.target.slug,
      token: s.target.member.token,
      body: {},
      env: clock,
    });
    expect(response.status).toBe(200);
    const summary = (await response.json()) as {
      prospective: number;
      workspaces: { id: string; prospective: number }[];
    };
    expect(summary.prospective).toBe(0);
    expect(summary.workspaces.find((w) => w.id === s.target.workspace.id)?.prospective).toBe(0);
  });

  test('保存済み依頼回の行が欠けていたら完了せず409で断り、記録も経験値も書かない', async () => {
    const s = await setup();
    await s.db.run(s.db.statement((q) => q.deleteFrom('review_request_cycles').where('task_id', '=', s.task.id)));
    const response = await call(s.target, s.task.id);
    expect(response.status).toBe(409);
    expect(await completions(s)).toEqual([]);
    expect(await grants(s)).toEqual([]);
    const row = await s.db.first(
      s.db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('completed_at')
          .where('id', '=', s.task.id)
          .where('workspace_id', '=', s.target.workspace.id),
      ),
    );
    expect(row?.completed_at).toBeNull();
  });

  test.each([null, 'leader'] as const)(
    'レビュー経験値の応答額は実行者自身が受け取った分だけ（担当=%s）',
    async (assignee) => {
      const s = await setup({ assignee });
      const response = await call(s.target, s.task.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ xp_granted: assignee === null ? 30 : 0 });
      expect(await grants(s)).toMatchObject([
        { action: 'review', amount: 30, user_id: assignee === null ? s.target.member.userId : s.target.leader.userId },
      ]);
    },
  );

  test.each(['planned', 'active'] as const)(
    '%sスプリント内のレビューを完了・取り消しすると配置と依頼回と経験値を戻す',
    async (status) => {
      const s = await setup();
      const column = await createBoardColumn(s.target.organization, s.target.workspace.id, {
        name: '作業中',
        position: 'a0',
      });
      await createBoardColumn(s.target.organization, s.target.workspace.id, { name: null, is_done: 1, position: 'a1' });
      const sprint = await createSprint(s.target.organization, s.target.workspace.id, { status });
      await createSprintEntry(
        s.target.organization,
        s.target.workspace.id,
        sprint.id,
        s.task.id,
        s.target.member.userId!,
      );
      await s.db.run(
        s.db.statement((q) =>
          q
            .updateTable('tasks')
            .set({ sprint_id: sprint.id, column_id: column.id, column_position: 'a0' })
            .where('id', '=', s.task.id)
            .where('workspace_id', '=', s.target.workspace.id),
        ),
      );
      const response = await call(s.target, s.task.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ left_sprint: status === 'planned', xp_granted: 30 });
      expect(await completions(s)).toMatchObject([
        {
          sprint_id: status === 'active' ? sprint.id : null,
          previous_column_id: status === 'active' ? column.id : null,
        },
      ]);
      expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
      expect(await completions(s)).toEqual([]);
      expect((await grants(s)).reduce((sum, r) => sum + r.amount, 0)).toBe(0);
      const row = await s.db.first(
        s.db.statement((q) =>
          q
            .selectFrom('tasks')
            .select(['completed_at', 'sprint_id', 'column_id'])
            .where('id', '=', s.task.id)
            .where('workspace_id', '=', s.target.workspace.id),
        ),
      );
      expect(row).toMatchObject({
        completed_at: null,
        sprint_id: status === 'active' ? sprint.id : null,
        column_id: status === 'active' ? column.id : null,
      });
      const cycle = await s.db.first(
        s.db.statement((q) =>
          q
            .selectFrom('review_request_cycles')
            .select('completion_id')
            .where('task_id', '=', s.task.id)
            .where('review_cycle', '=', 'request-1'),
        ),
      );
      expect(cycle?.completion_id).toBeNull();
    },
  );

  test('完了対象の読み取り後に依頼回の版が進んだら読み直して完了し二重付与しない', async () => {
    const s = await setup();
    let changed = false;
    const requestEnv = envWithD1Hooks(clock, {
      afterQuery: async (sql) => {
        if (changed || !sql.includes('"tasks"') || !sql.includes('"task_sources"') || !sql.includes('"sprints"'))
          return;
        changed = true;
        await s.db.run(
          s.db.statement((q) =>
            q
              .updateTable('task_sources')
              .set({ review_revision: 1 })
              .where('task_id', '=', s.task.id)
              .where('workspace_id', '=', s.target.workspace.id),
          ),
        );
      },
    });
    const response = await post(app, taskComplete, {
      slug: s.target.slug,
      token: s.target.member.token,
      body: { workspace_id: s.target.workspace.id, task_id: s.task.id },
      env: requestEnv,
    });
    expect(changed).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ xp_granted: 30 });
    expect(await completions(s)).toHaveLength(1);
    expect(await grants(s)).toMatchObject([{ action: 'review', amount: 30 }]);
  });

  test('PR の完了は従来どおり task_completed を付ける', async () => {
    const s = await setup({ kind: 'pull_request', cycle: null });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toMatchObject([{ action: 'task_completed', amount: 30 }]);
  });
});
