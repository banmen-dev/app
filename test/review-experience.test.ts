import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, readReviewTarget, reviewUpdateStatements } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { taskComplete, taskReopen } from '../src/shared/operations/task/index.ts';
import {
  createConnection,
  createTask,
  createTaskSource,
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

describe('レビュー依頼の回ごとの完了', () => {
  test('提出・終了の同期検知は印だけを変え完了記録を作らず、人の完了でも経験値の明細は増えない', async () => {
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
    expect(await grants(s)).toEqual([]);
  });

  test('人が完了した時だけ依頼回と完了を結び、経験値の明細は増えない', async () => {
    const s = await setup({ assignee: 'leader' });
    expect(await grants(s)).toEqual([]);
    const response = await call(s.target, s.task.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ xp_granted: 0 });
    expect(await grants(s)).toEqual([]);
    const records = await completions(s);
    expect(records).toHaveLength(1);
    const cycles = await s.db.rows(
      s.db.statement((q) => q.selectFrom('review_request_cycles').selectAll().where('task_id', '=', s.task.id)),
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].completion_id).toBe(records[0].id);
  });

  test('同じ依頼回の再送と並行完了で二重に完了記録を作らない', async () => {
    const s = await setup();
    const responses = await Promise.all([call(s.target, s.task.id), call(s.target, s.task.id)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call(s.target, s.task.id)).status).toBe(409);
    expect(await grants(s)).toEqual([]);
    expect(await completions(s)).toHaveLength(1);
  });

  test.each([0, null])('ポイント %s でも完了記録を作り、経験値の明細は増えない', async (points) => {
    const s = await setup({ points });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toEqual([]);
    expect(await completions(s)).toHaveLength(1);
  });

  test('通常の取り消しは当該回の完了記録を消し、同じ回の再完了は完了記録1件に戻る', async () => {
    const s = await setup();
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    expect(await completions(s)).toEqual([]);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toEqual([]);
    expect(await completions(s)).toHaveLength(1);
  });

  test('同じ時刻の再依頼後も過去の完了を残し、取り消しは次回の完了だけを消す', async () => {
    const s = await setup();
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const first = (await completions(s))[0];
    await nextCycle(s);
    expect(await completions(s)).toHaveLength(1);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await completions(s)).toHaveLength(2);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    expect(await completions(s)).toMatchObject([{ id: first.id }]);
    expect(await grants(s)).toEqual([]);
  });

  test('依頼回なしで完了した旧行を初回同期した後でも当該完了を取り消せる', async () => {
    const s = await setup({ cycle: null });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    const first = (await completions(s))[0];
    await syncReview(s, 'request-1', true);
    expect(await completions(s)).toMatchObject([{ id: first.id }]);
    expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
    expect(await completions(s)).toEqual([]);
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await completions(s)).toHaveLength(1);
    expect(await grants(s)).toEqual([]);
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
    expect(await grants(s)).toEqual([]);
  });

  test.each([false, true])('現在の依頼回の行が欠けていたら409で何も書かない（旧回の行=%s）', async (oldCycle) => {
    const s = await setup();
    await s.db.run(s.db.statement((q) => q.deleteFrom('review_request_cycles').where('task_id', '=', s.task.id)));
    if (oldCycle)
      await s.db.run(
        s.db.statement((q) =>
          q
            .insertInto('review_request_cycles')
            .values({ task_id: s.task.id, review_cycle: 'request-old', completion_id: null, created_at: AT }),
        ),
      );
    const response = await call(s.target, s.task.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
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

  test.each(['planned', 'active'] as const)(
    '%sスプリントのレビュー完了・取消で、進行中の配置だけを復元し予定の所属は外したままにする',
    async (status) => {
      const s = await setup();
      const column = await createBoardColumn(s.target.organization, s.target.workspace.id, {
        name: '作業中',
        position: 'a0',
      });
      const done = await createBoardColumn(s.target.organization, s.target.workspace.id, {
        name: null,
        is_done: 1,
        position: 'a1',
      });
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
      expect(await response.json()).toMatchObject({ left_sprint: status === 'planned', xp_granted: 0 });
      expect(await completions(s)).toMatchObject([
        {
          sprint_id: status === 'active' ? sprint.id : null,
          previous_column_id: status === 'active' ? column.id : null,
        },
      ]);
      const completedTask = await s.db.first(
        s.db.statement((q) =>
          q
            .selectFrom('tasks')
            .select(['sprint_id', 'column_id', 'column_position'])
            .where('id', '=', s.task.id)
            .where('workspace_id', '=', s.target.workspace.id),
        ),
      );
      expect(completedTask).toMatchObject({
        sprint_id: status === 'active' ? sprint.id : null,
        column_id: status === 'active' ? done.id : null,
        column_position: status === 'active' ? expect.any(String) : null,
      });
      const entries = () =>
        s.db.rows(
          s.db.statement((q) =>
            q
              .selectFrom('sprint_entries')
              .select(['ended_at', 'outcome'])
              .where('workspace_id', '=', s.target.workspace.id)
              .where('task_id', '=', s.task.id),
          ),
        );
      expect(await entries()).toEqual([
        { ended_at: status === 'active' ? null : AT, outcome: status === 'active' ? null : 'removed' },
      ]);
      expect((await call(s.target, s.task.id, taskReopen)).status).toBe(200);
      expect(await entries()).toEqual([
        { ended_at: status === 'active' ? null : AT, outcome: status === 'active' ? null : 'removed' },
      ]);
      expect(await completions(s)).toEqual([]);
      expect(await grants(s)).toEqual([]);
      const row = await s.db.first(
        s.db.statement((q) =>
          q
            .selectFrom('tasks')
            .select(['completed_at', 'sprint_id', 'column_id', 'column_position'])
            .where('id', '=', s.task.id)
            .where('workspace_id', '=', s.target.workspace.id),
        ),
      );
      expect(row).toMatchObject({
        completed_at: null,
        sprint_id: status === 'active' ? sprint.id : null,
        column_id: status === 'active' ? column.id : null,
        column_position: status === 'active' ? expect.any(String) : null,
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

  test('完了対象の読み取り後に依頼回の版が進んだら読み直して完了し、二重に完了しない', async () => {
    const s = await setup();
    let changed = false;
    let reads = 0;
    const requestEnv = envWithD1Hooks(clock, {
      afterQuery: async (sql) => {
        if (!sql.includes('as "sprint_deleted_at"') || !sql.includes('left join "task_sources"')) return;
        reads++;
        if (changed) return;
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
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ xp_granted: 0 });
    expect(await completions(s)).toHaveLength(1);
    expect((await call(s.target, s.task.id)).status).toBe(409);
    expect(await grants(s)).toEqual([]);
  });

  test('読み取り後に新しい依頼回へ変わったら次回だけに完了を接続し、再送にも二重に完了しない', async () => {
    const s = await setup();
    let changed = false;
    let reads = 0;
    const requestEnv = envWithD1Hooks(clock, {
      afterQuery: async (sql) => {
        if (!sql.includes('as "sprint_deleted_at"') || !sql.includes('left join "task_sources"')) return;
        reads++;
        if (changed) return;
        changed = true;
        await s.db.batch([
          s.db.statement((q) =>
            q
              .updateTable('task_sources')
              .set({ review_cycle: 'request-2', review_revision: 1 })
              .where('workspace_id', '=', s.target.workspace.id)
              .where('task_id', '=', s.task.id),
          ),
          s.db.statement((q) =>
            q
              .insertInto('review_request_cycles')
              .values({ task_id: s.task.id, review_cycle: 'request-2', completion_id: null, created_at: AT }),
          ),
        ]);
      },
    });
    const response = await post(app, taskComplete, {
      slug: s.target.slug,
      token: s.target.member.token,
      body: { workspace_id: s.target.workspace.id, task_id: s.task.id },
      env: requestEnv,
    });
    expect(changed).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(response.status).toBe(200);
    const records = await completions(s);
    expect(records).toHaveLength(1);
    const cycles = await s.db.rows(
      s.db.statement((q) =>
        q
          .selectFrom('review_request_cycles')
          .select(['review_cycle', 'completion_id'])
          .where('task_id', '=', s.task.id)
          .orderBy('review_cycle'),
      ),
    );
    expect(cycles).toEqual([
      { review_cycle: 'request-1', completion_id: null },
      { review_cycle: 'request-2', completion_id: records[0].id },
    ]);
    expect((await call(s.target, s.task.id)).status).toBe(409);
    expect(await grants(s)).toEqual([]);
  });

  test('別組織のレビュー依頼のIDは404で、元タスクの完了記録も経験値も作らない', async () => {
    const s = await setup();
    const other = await createTarget();
    const response = await post(app, taskComplete, {
      slug: other.slug,
      token: other.member.token,
      body: { workspace_id: other.workspace.id, task_id: s.task.id },
      env: clock,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(await completions(s)).toEqual([]);
    expect(await grants(s)).toEqual([]);
  });

  test('PR の完了でも経験値の明細は増えない', async () => {
    const s = await setup({ kind: 'pull_request', cycle: null });
    expect((await call(s.target, s.task.id)).status).toBe(200);
    expect(await grants(s)).toEqual([]);
  });
});
