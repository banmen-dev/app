import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { experienceSummary } from '../src/shared/operations/experience/index.ts';
import { taskComplete, taskReopen, taskFieldSet } from '../src/shared/operations/task/index.ts';
import { createDetailField, createMembership, createTask, createTaskFieldValue, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv, type Target, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
const AT = '2026-11-01T00:00:00.000Z';

async function call(
  target: Target,
  operation: Parameters<typeof post>[1],
  body = {},
  person = target.member,
  statuses = [200],
) {
  const res = await post(app, operation, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
    env: Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: AT }),
  });
  expect(statuses).toContain(res.status);
  return res;
}
async function summary(target: Target, person: Person = target.member) {
  const res = await call(target, experienceSummary, {}, person);
  return (await res.json()) as {
    total: number;
    prospective: number;
    workspaces: { id: string; prospective: number }[];
  };
}
async function grants(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .selectAll()
        .where('workspace_id', '=', target.workspace.id)
        .where('task_id', '=', taskId)
        .where('action', '=', 'task_detailed'),
    ),
  );
}
async function setup(points: number | null = 1, imported = false) {
  const target = await createTarget();
  await createMembership(target.organization, target.workspace.id, target.admin.userId!);
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
    points,
    ...(imported ? { is_imported: 1, created_by: null } : {}),
  });
  const first = await createDetailField(target.organization, target.workspace.id, { name: '基準' });
  const last = await createDetailField(target.organization, target.workspace.id, { name: '範囲', position: 'a1' });
  await createTaskFieldValue(target.organization, task.id, first.id, target.admin.userId!, {
    updated_at: '2026-10-20T00:00:00.000Z',
  });
  await createTaskFieldValue(target.organization, task.id, last.id, target.member.userId!, {
    updated_at: '2026-10-21T00:00:00.000Z',
  });
  return { target, task, first, last, db: orgDb(env, target.organization.verified) };
}

describe('詳細の経験値', () => {
  test.each([false, true])(
    '最後の更新者の見込みと確定に20を足す（取り込み=%s）。同時の完了でも1回だけ',
    async (imported) => {
      const { target, task } = await setup(1, imported);
      expect(await summary(target)).toMatchObject({ total: 0, prospective: imported ? 20 : 30 });
      expect((await summary(target, target.admin)).prospective).toBe(0);
      const results = await Promise.all([
        call(target, taskComplete, { task_id: task.id }, target.admin, [200, 409]),
        call(target, taskComplete, { task_id: task.id }, target.admin, [200, 409]),
      ]);
      expect(results.some((res) => res.status === 200)).toBe(true);
      const rows = await grants(target, task.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: target.member.userId,
        amount: 20,
        dedupe_key: `task_detailed:${rows[0].completion_id}`,
      });
      expect(await summary(target)).toMatchObject({ total: imported ? 20 : 30, prospective: 0 });
    },
  );

  test.each([0, null])('ポイント%sなら見込みにも確定にも付けない', async (points) => {
    const { target, task } = await setup(points);
    expect((await summary(target)).prospective).toBe(0);
    await call(target, taskComplete, { task_id: task.id });
    expect(await grants(target, task.id)).toHaveLength(0);
  });

  test.each(['未記入', '欄0件'] as const)('%sなら付かない', async (kind) => {
    const { target, task, last, db } = await setup();
    if (kind === '未記入')
      await db.run(
        db.statement((q) =>
          q.deleteFrom('task_field_values').where('task_id', '=', task.id).where('field_id', '=', last.id),
        ),
      );
    else
      await db.run(
        db.statement((q) =>
          q.updateTable('detail_fields').set({ deleted_at: AT }).where('workspace_id', '=', target.workspace.id),
        ),
      );
    expect((await summary(target)).prospective).toBe(10);
    await call(target, taskComplete, { task_id: task.id });
    expect(await grants(target, task.id)).toHaveLength(0);
  });

  test('削除した欄の新しい値は無視し、同時刻ならfield_idの降順で受取人を固定する', async () => {
    const { target, task, first, last, db } = await setup();
    await db.run(
      db.statement((q) => q.updateTable('task_field_values').set({ updated_at: AT }).where('task_id', '=', task.id)),
    );
    const deleted = await createDetailField(target.organization, target.workspace.id, { name: '旧欄', deleted_at: AT });
    await createTaskFieldValue(target.organization, task.id, deleted.id, target.admin.userId!, {
      updated_at: '2026-11-02T00:00:00.000Z',
    });
    const winner = first.id > last.id ? target.admin : target.member;
    expect((await summary(target, winner)).prospective).toBe(winner === target.member ? 30 : 20);
    await call(target, taskComplete, { task_id: task.id });
    expect((await grants(target, task.id))[0].user_id).toBe(winner.userId);
  });

  test('最後の更新者が離脱済みなら繰り上げない', async () => {
    const { target, task, db } = await setup();
    const other = await createWorkspace(target.organization, target.admin.userId!);
    await createMembership(target.organization, other.id, target.member.userId!);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: AT, left_on: '2026-11-01' })
          .where('workspace_id', '=', target.workspace.id)
          .where('user_id', '=', target.member.userId!),
      ),
    );
    expect((await summary(target)).prospective).toBe(0);
    expect((await summary(target, target.admin)).prospective).toBe(0);
    await call(target, taskComplete, { task_id: task.id }, target.admin);
    expect(await grants(target, task.id)).toHaveLength(0);
  });

  test('確定後の欄変更では動かず、戻すと打ち消し、同じ時刻の再完了は新しい受取人に付ける', async () => {
    const { target, task, last } = await setup();
    await call(target, taskComplete, { task_id: task.id });
    await call(
      target,
      taskFieldSet,
      { task_id: task.id, field_id: last.id, value_md: '書き直し', read_md: '- 影響する画面を挙げてある' },
      target.admin,
    );
    expect((await grants(target, task.id))[0]).toMatchObject({ user_id: target.member.userId, amount: 20 });
    await call(target, taskReopen, { task_id: task.id });
    expect((await summary(target, target.admin)).prospective).toBe(20);
    await call(target, taskComplete, { task_id: task.id });
    const rows = await grants(target, task.id);
    expect(rows).toHaveLength(3);
    expect(
      rows
        .filter((r) => r.amount === 20)
        .map((r) => r.user_id)
        .sort(),
    ).toEqual([target.member.userId, target.admin.userId].sort());
    expect(rows.find((r) => r.amount === -20)?.reverses_grant_id).toBe(
      rows.find((r) => r.user_id === target.member.userId && r.amount === 20)?.id,
    );
    expect(new Set(rows.filter((r) => r.amount === 20).map((r) => r.completion_id)).size).toBe(2);
  });

  test.each(['閉鎖', '削除', '受信箱', 'アーカイブ'] as const)('%sのタスクの詳細は見込みから外す', async (state) => {
    const { target, task, db } = await setup(1, true);
    if (state === '閉鎖')
      await db.run(
        db.statement((q) =>
          q
            .updateTable('workspaces')
            .set({ closed_at: AT })
            .where('id', '=', target.workspace.id)
            .where('organization_id', '=', target.organization.id),
        ),
      );
    else
      await db.run(
        db.statement((q) =>
          q
            .updateTable('tasks')
            .set(state === '削除' ? { deleted_at: AT } : { tray: state === '受信箱' ? 'inbox' : 'archive' })
            .where('id', '=', task.id)
            .where('workspace_id', '=', target.workspace.id),
        ),
      );
    expect((await summary(target)).prospective).toBe(0);
  });

  test('見込みはポイント、欄の追加・削除、値の消去と更新者の交代に追従する', async () => {
    const { target, task, last, db } = await setup(0);
    expect((await summary(target)).prospective).toBe(0);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ points: 1 })
          .where('id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await summary(target)).prospective).toBe(30);
    const extra = await createDetailField(target.organization, target.workspace.id, { name: '追加条件' });
    expect((await summary(target)).prospective).toBe(10);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('detail_fields')
          .set({ deleted_at: AT })
          .where('id', '=', extra.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await summary(target)).prospective).toBe(30);
    await call(target, taskFieldSet, {
      task_id: task.id,
      field_id: last.id,
      value_md: null,
      read_md: '- 影響する画面を挙げてある',
    });
    expect((await summary(target)).prospective).toBe(10);
    await call(
      target,
      taskFieldSet,
      { task_id: task.id, field_id: last.id, value_md: '新しい条件', read_md: null },
      target.admin,
    );
    expect((await summary(target)).prospective).toBe(10);
    expect((await summary(target, target.admin)).prospective).toBe(20);
  });

  test('確定後に欄を追加・削除しても明細を動かさず、再完了では現在の未記入を判定する', async () => {
    const { target, task } = await setup();
    await call(target, taskComplete, { task_id: task.id });
    const before = await grants(target, task.id);
    await createDetailField(target.organization, target.workspace.id, { name: '完了後の新しい欄' });
    expect(await grants(target, task.id)).toEqual(before);
    await call(target, taskReopen, { task_id: task.id });
    expect((await summary(target)).prospective).toBe(10);
    await call(target, taskComplete, { task_id: task.id });
    const rows = await grants(target, task.id);
    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([-20, 20]);
  });

  test('別ワークスペースの欄と値が混ざっていても、受取人と未記入の判定に使わない', async () => {
    const { target, task } = await setup();
    const other = await createWorkspace(target.organization, target.admin.userId!);
    const field = await createDetailField(target.organization, other.id);
    await createTaskFieldValue(target.organization, task.id, field.id, target.admin.userId!, { updated_at: AT });
    expect((await summary(target)).prospective).toBe(30);
    await call(target, taskComplete, { task_id: task.id });
    expect((await grants(target, task.id))[0].user_id).toBe(target.member.userId);
  });
});
