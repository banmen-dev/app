// タスクの決まった欄の値（task_field_values）の書き込み（task-field-set）と、引き出しが読む欄と値（task-detail の fields）。
// 未記入の印と件数は出さない（#1263）ので、backlog-tree、task-create、plan-summary、task-detail、task-field-set の出力に
// 未記入の項目が無いことも確かめる。組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  backlogTree,
  taskComplete,
  taskCreate,
  taskDetail,
  taskFieldSet,
  taskHistory,
} from '../src/shared/operations/task/index.ts';
import { detailFieldDelete, detailFieldList } from '../src/shared/operations/definition/index.ts';
import { planSummary } from '../src/shared/operations/sprint/index.ts';
import { planLaneSchema } from '../src/shared/operations/sprint/plan-summary.ts';
import { backlogTaskSchema } from '../src/shared/operations/task/backlog-tree.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createBoardColumn,
  createDetailField,
  createSprint,
  createStory,
  createTask,
  createTaskFieldValue,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ErrorBody = { error: { code: string; details?: { reason?: string } } };
type SetBody = { field: { id: string; name: string; value_md: string | null } };

async function call<T = Record<string, unknown>>(
  definition: AnyOperationDefinition,
  target: Target,
  body: Record<string, unknown>,
  person: Person = target.member,
): Promise<{ status: number; body: T }> {
  const res = await post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
  return { status: res.status, body: (await res.json()) as T };
}

const setField = (
  target: Target,
  taskId: string,
  fieldId: string,
  valueMd: string | null,
  readMd: string | null,
  person?: Person,
) =>
  call<SetBody & ErrorBody>(
    taskFieldSet,
    target,
    { task_id: taskId, field_id: fieldId, value_md: valueMd, read_md: readMd },
    person,
  );

async function storedValue(target: Target, taskId: string, fieldId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('task_field_values')
        .select(['value_md', 'updated_by'])
        .where('task_id', '=', taskId)
        .where('field_id', '=', fieldId),
    ),
  );
}

async function taskLogs(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['action', 'changes_json', 'actor_user_id', 'workspace_id'])
        .where('organization_id', '=', target.organization.id)
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', taskId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as Record<string, unknown> }));
}

// 1 つのワークスペースに欄を 2 つ（受け入れ基準と影響範囲）と、未完了のタスクを 1 つ
async function world(options: { closed?: boolean } = {}) {
  const target = await createTarget(options);
  const memberId = target.member.userId!;
  const criteria = await createDetailField(target.organization, target.workspace.id, { name: '受け入れ基準' });
  const impact = await createDetailField(target.organization, target.workspace.id, {
    name: '影響範囲',
    position: 'a1',
  });
  const task = await createTask(target.organization, target.workspace.id, memberId);
  return { target, memberId, criteria, impact, task };
}

describe('task-field-set', () => {
  test('行が無い欄に書くと値が入り、履歴に欄の名前だけが残る（値の全文は入らない）', async () => {
    const { target, memberId, criteria, task } = await world();
    const text = '- 影響する画面を挙げてある\n- 確かめる手順がある';
    const res = await setField(target, task.id, criteria.id, text, null);
    expect(res.status).toBe(200);
    // 返すのは書いた後の欄だけ（未記入かは返さない）
    expect(res.body).toEqual({ field: { id: criteria.id, name: '受け入れ基準', value_md: text } });
    expect(await storedValue(target, task.id, criteria.id)).toEqual({ value_md: text, updated_by: memberId });

    const logs = await taskLogs(target, task.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'update',
      actor_user_id: memberId,
      workspace_id: target.workspace.id,
      changes: { field: [null, { id: criteria.id, name: '受け入れ基準' }] },
    });
    expect(logs[0]?.changes_json).not.toContain('影響する画面');
  });

  test('読んだ値のままなら直せる。履歴は前後とも欄の名前だけ', async () => {
    const { target, criteria, impact, task } = await world();
    await setField(target, task.id, criteria.id, '一次', null);
    const edited = await setField(target, task.id, criteria.id, '二次', '一次');
    expect(edited.status).toBe(200);
    expect(edited.body.field.value_md).toBe('二次');
    expect((await taskLogs(target, task.id)).at(-1)?.changes).toEqual({
      field: [
        { id: criteria.id, name: '受け入れ基準' },
        { id: criteria.id, name: '受け入れ基準' },
      ],
    });
    const all = await setField(target, task.id, impact.id, '画面 A', null);
    expect(all.body.field.value_md).toBe('画面 A');
  });

  test('空（空白だけを含む）か null にすると行を消して値が null に戻り、履歴は「あり → なし」', async () => {
    const { target, criteria, impact, task } = await world();
    await setField(target, task.id, criteria.id, '一次', null);
    await setField(target, task.id, impact.id, '画面 A', null);
    const cleared = await setField(target, task.id, criteria.id, '  \n \n', '一次');
    expect(cleared.status).toBe(200);
    expect(cleared.body.field.value_md).toBeNull();
    expect(await storedValue(target, task.id, criteria.id)).toBeUndefined();
    expect((await taskLogs(target, task.id)).at(-1)?.changes).toEqual({
      field: [{ id: criteria.id, name: '受け入れ基準' }, null],
    });
    const nullCleared = await setField(target, task.id, impact.id, null, '画面 A');
    expect(nullCleared.status).toBe(200);
    expect(await storedValue(target, task.id, impact.id)).toBeUndefined();
  });

  test('値は本文と同じ正規化を通す（改行をそろえ、前後の空行と末尾の空白を落とす）', async () => {
    const { target, criteria, task } = await world();
    const res = await setField(target, task.id, criteria.id, '\r\n\r\n- 一つ目\r\n- 二つ目  \r\n\r\n', null);
    expect(res.status).toBe(200);
    expect(res.body.field.value_md).toBe('- 一つ目\n- 二つ目');
  });

  test('1 万字まで書け、1 万 1 字と見えない文字は 400', async () => {
    const { target, criteria, task } = await world();
    expect((await setField(target, task.id, criteria.id, 'あ'.repeat(10_001), null)).status).toBe(400);
    expect((await setField(target, task.id, criteria.id, '欄​', null)).status).toBe(400);
    expect((await setField(target, task.id, criteria.id, 'あ'.repeat(10_000), null)).status).toBe(200);
  });

  test('読んだ値と今の値が違うと 409 の changed で、上書きも削除もしない', async () => {
    const { target, criteria, task } = await world();
    await setField(target, task.id, criteria.id, '先に書かれた', null);

    // 行が無いと思って書く（同時に別の人が先に書いた）
    const insert = await setField(target, task.id, criteria.id, '自分の値', null);
    expect(insert.status).toBe(409);
    expect(insert.body.error).toMatchObject({ code: 'conflict', details: { reason: 'changed' } });
    // 古い値を読んで直す
    const update = await setField(target, task.id, criteria.id, '自分の値', '古い値');
    expect(update.status).toBe(409);
    expect(update.body.error.details?.reason).toBe('changed');
    // 古い値を読んで消す
    const remove = await setField(target, task.id, criteria.id, null, '古い値');
    expect(remove.status).toBe(409);
    expect(remove.body.error.details?.reason).toBe('changed');

    expect((await storedValue(target, task.id, criteria.id))?.value_md).toBe('先に書かれた');
    // 負けた書き込みは履歴を残さない
    expect(await taskLogs(target, task.id)).toHaveLength(1);

    // 読み直した値で書き直せる
    expect((await setField(target, task.id, criteria.id, '自分の値', '先に書かれた')).status).toBe(200);
  });

  test('同じ欄に同時に書くと、片方だけが通り、負けた方は 409 の changed', async () => {
    const { target, criteria, task } = await world();
    const inserts = await Promise.all([
      setField(target, task.id, criteria.id, 'A さんの値', null, target.member),
      setField(target, task.id, criteria.id, 'B さんの値', null, target.leader),
    ]);
    expect(inserts.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = (await storedValue(target, task.id, criteria.id))?.value_md;
    expect(['A さんの値', 'B さんの値']).toContain(winner);

    const updates = await Promise.all([
      setField(target, task.id, criteria.id, '更新 1', winner!, target.member),
      setField(target, task.id, criteria.id, '更新 2', winner!, target.leader),
    ]);
    expect(updates.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await taskLogs(target, task.id)).length).toBe(2);
  });

  test('読んだ値と同じ値を書くなら何も書かず、履歴も残さない', async () => {
    const { target, criteria, task } = await world();
    const none = await setField(target, task.id, criteria.id, null, null);
    expect(none.status).toBe(200);
    expect(none.body.field.value_md).toBeNull();
    await setField(target, task.id, criteria.id, '一次', null);
    const same = await setField(target, task.id, criteria.id, '一次', '一次');
    expect(same.status).toBe(200);
    expect(same.body.field.value_md).toBe('一次');
    expect(await taskLogs(target, task.id)).toHaveLength(1);
  });

  test('完了したタスクにも書ける', async () => {
    const { target, criteria, task } = await world();
    expect((await call(taskComplete, target, { task_id: task.id })).status).toBe(200);
    const res = await setField(target, task.id, criteria.id, '完了後に書いた', null);
    expect(res.status).toBe(200);
    expect(res.body.field.value_md).toBe('完了後に書いた');
  });

  test('削除した欄、無い欄、別のワークスペースと別の組織の欄とタスク、削除したタスクは 404', async () => {
    const { target, criteria, task } = await world();
    const deleted = await createDetailField(target.organization, target.workspace.id, {
      name: '旧欄',
      position: 'a2',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const elsewhereField = await createDetailField(target.organization, target.otherWorkspace.id);
    const elsewhereTask = await createTask(target.organization, target.otherWorkspace.id, target.bystander.userId!);
    const goneTask = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const stranger = await createTarget();
    const strangerField = await createDetailField(stranger.organization, stranger.workspace.id);
    const strangerTask = await createTask(stranger.organization, stranger.workspace.id, stranger.member.userId!);

    const cases: [string, string][] = [
      [task.id, deleted.id],
      [task.id, elsewhereField.id],
      [task.id, crypto.randomUUID()],
      [task.id, strangerField.id],
      [elsewhereTask.id, criteria.id],
      [goneTask.id, criteria.id],
      [strangerTask.id, criteria.id],
      [crypto.randomUUID(), criteria.id],
    ];
    for (const [taskId, fieldId] of cases) {
      expect((await setField(target, taskId, fieldId, '値', null)).status, `${taskId} ${fieldId}`).toBe(404);
    }
    expect(await storedValue(target, task.id, deleted.id)).toBeUndefined();
  });

  test('閉じたワークスペースは 409 の workspace_closed', async () => {
    const { target, criteria, task } = await world({ closed: true });
    const res = await setField(target, task.id, criteria.id, '値', null);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workspace_closed');
    expect(await storedValue(target, task.id, criteria.id)).toBeUndefined();
  });

  test('変更の履歴（task-history）は、欄の名前だけを返し、値の全文を含まない', async () => {
    const { target, criteria, task } = await world();
    await setField(target, task.id, criteria.id, '秘密のメモ', null);
    const res = await call<{
      entries: { action: string; changes: { field: string; before: unknown; after: unknown }[] }[];
    }>(taskHistory, target, { task_id: task.id });
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      action: 'update',
      changes: [{ field: 'field', before: null, after: { id: criteria.id, name: '受け入れ基準' } }],
    });
    expect(JSON.stringify(res.body)).not.toContain('秘密のメモ');
  });
});

describe('欄と値の読み', () => {
  test('task-detail は削除していない欄を並びの順に値つきで返す。書くと値が入り、未記入かは返さない', async () => {
    const { target, memberId, criteria, impact, task } = await world();
    const deleted = await createDetailField(target.organization, target.workspace.id, {
      name: '旧欄',
      position: 'a2',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createTaskFieldValue(target.organization, task.id, deleted.id, memberId, { value_md: '旧欄の値' });
    await createTaskFieldValue(target.organization, task.id, criteria.id, memberId, { value_md: '基準を書いた' });

    const partly = await call<{ fields: unknown[] }>(taskDetail, target, { task_id: task.id });
    expect(partly.status).toBe(200);
    expect(partly.body.fields).toEqual([
      { id: criteria.id, name: '受け入れ基準', value_md: '基準を書いた' },
      { id: impact.id, name: '影響範囲', value_md: null },
    ]);
    expect(partly.body).not.toHaveProperty('unfilled');

    await setField(target, task.id, impact.id, '画面 A', null);
    const filled = await call<{ fields: { value_md: string | null }[] }>(taskDetail, target, { task_id: task.id });
    expect(filled.body.fields.map((field) => field.value_md)).toEqual(['基準を書いた', '画面 A']);
  });

  test('完了したタスクも欄を返す。欄が 1 つも無ければ空', async () => {
    const { target, task } = await world();
    await call(taskComplete, target, { task_id: task.id });
    const done = await call<{ fields: unknown[] }>(taskDetail, target, { task_id: task.id });
    expect(done.body.fields).toHaveLength(2);

    const plain = await createTarget();
    const bare = await createTask(plain.organization, plain.workspace.id, plain.member.userId!);
    const none = await call<{ fields: unknown[] }>(taskDetail, plain, { task_id: bare.id });
    expect(none.body.fields).toEqual([]);
  });

  test('欄を削除すると、その欄は task-detail に出なくなる（値の行は残る）', async () => {
    const { target, memberId, criteria, impact, task } = await world();
    await createTaskFieldValue(target.organization, task.id, impact.id, memberId, { value_md: '画面 A' });
    expect((await call(detailFieldDelete, target, { field_id: impact.id }, target.leader)).status).toBe(200);
    const after = await call<{ fields: { id: string }[] }>(taskDetail, target, { task_id: task.id });
    expect(after.body.fields.map((field) => field.id)).toEqual([criteria.id]);
    expect(await storedValue(target, task.id, impact.id)).toEqual({ value_md: '画面 A', updated_by: memberId });
  });

  // 応答は出力のスキーマで parse され、知らない項目は捨てられる。応答だけを見ても、スキーマから外したことしか分からないので、
  // スキーマの項目も確かめる（足し戻すと落ちる）
  test('出力のスキーマに未記入の項目（unfilled、unfilled_count）が無い', () => {
    expect(Object.keys(backlogTaskSchema.shape)).not.toContain('unfilled');
    expect(Object.keys(backlogTree.output.shape)).not.toContain('unfilled_count');
    expect(Object.keys(taskCreate.output.shape)).toEqual(['task']);
    expect(Object.keys(taskDetail.output.shape)).not.toContain('unfilled');
    expect(Object.keys(taskFieldSet.output.shape)).toEqual(['field']);
    expect(Object.keys(planLaneSchema.shape)).not.toContain('unfilled_count');
  });

  test('backlog-tree、task-create、plan-summary の応答は、欄が空のタスクがあっても未記入の項目を含まない', async () => {
    const { target, memberId } = await world();
    const { organization } = target;
    const workspaceId = target.workspace.id;
    const story = await createStory(organization, workspaceId, memberId, { title: '決済の画面' });
    await createTask(organization, workspaceId, memberId, { story_id: story.id, title: '入力欄を作る' });
    const sprint = await createSprint(organization, workspaceId, { status: 'planned' });
    const column = await createBoardColumn(organization, workspaceId);
    await createTask(organization, workspaceId, memberId, {
      sprint_id: sprint.id,
      column_id: column.id,
      column_position: 'a0',
    });

    const tree = await call<{ tasks: object[]; stories: { tasks: object[] }[] }>(backlogTree, target, {});
    expect(tree.status).toBe(200);
    expect(tree.body).not.toHaveProperty('unfilled_count');
    const rows = [...tree.body.tasks, ...tree.body.stories.flatMap((s) => s.tasks)];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty('unfilled');

    const created = await call<{ task: object }>(taskCreate, target, { title: '新しいタスク' });
    expect(created.status).toBe(200);
    expect(created.body.task).not.toHaveProperty('unfilled');

    const plan = await call<{ lanes: object[] }>(planSummary, target, {});
    expect(plan.status).toBe(200);
    expect(plan.body.lanes).toHaveLength(1);
    for (const lane of plan.body.lanes) expect(lane).not.toHaveProperty('unfilled_count');
  });

  test('別のワークスペースと別の組織の欄は、task-detail の欄にも欄の一覧にも混ざらない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const memberId = target.member.userId!;
    // 自分のワークスペースは欄が 0 件で、タスクが 1 件
    const task = await createTask(organization, target.workspace.id, memberId);
    // 別のワークスペースと別の組織に、欄を 1 件ずつ
    await createDetailField(organization, target.otherWorkspace.id, { name: '別のワークスペースの欄' });
    const stranger = await createTarget();
    await createDetailField(stranger.organization, stranger.workspace.id, { name: '別の組織の欄' });

    const detail = await call<{ fields: unknown[] }>(taskDetail, target, { task_id: task.id });
    expect(detail.body.fields).toEqual([]);
    const list = await call<{ fields: unknown[] }>(detailFieldList, target, {});
    expect(list.body.fields).toEqual([]);
  });

  test('受信箱のタスクにも書け、task-detail はバックログのタスクかを返す', async () => {
    const { target, criteria, task } = await world();
    const inbox = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      is_imported: 1,
      tray: 'inbox',
    });
    const detail = await call<{ in_backlog: boolean }>(taskDetail, target, { task_id: inbox.id });
    expect(detail.body.in_backlog).toBe(false);
    const backlogDetail = await call<{ in_backlog: boolean }>(taskDetail, target, { task_id: task.id });
    expect(backlogDetail.body.in_backlog).toBe(true);
    const set = await setField(target, inbox.id, criteria.id, '受信箱で書いた', null);
    expect(set.status).toBe(200);
    expect(set.body.field.value_md).toBe('受信箱で書いた');
  });

  test('成功した書き込みを再送しても 200 で今の値を返し、履歴は 1 件のまま', async () => {
    const { target, criteria, task } = await world();
    const first = await setField(target, task.id, criteria.id, 'x', null);
    const again = await setField(target, task.id, criteria.id, 'x', null);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.field.value_md).toBe('x');
    expect(await taskLogs(target, task.id)).toHaveLength(1);

    // 空にする書き込みの再送も同じ
    const cleared = await setField(target, task.id, criteria.id, null, 'x');
    const clearedAgain = await setField(target, task.id, criteria.id, null, 'x');
    expect(cleared.status).toBe(200);
    expect(clearedAgain.status).toBe(200);
    expect(clearedAgain.body.field.value_md).toBeNull();
    expect(await taskLogs(target, task.id)).toHaveLength(2);

    // 違う値が入っているときは、これまでどおり 409 の changed
    await setField(target, task.id, criteria.id, '別の人の値', null);
    expect((await setField(target, task.id, criteria.id, 'y', 'x')).status).toBe(409);
  });
});
