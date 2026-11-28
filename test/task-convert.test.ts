// タスクの種類の変更（task-convert）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { taskConvert, taskDetail, taskRestore } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { uuidv7 } from '../src/server/uuid.ts';
import {
  createAttachment,
  createBoardColumn,
  createCategory,
  createComment,
  createDetailField,
  createEpic,
  createSprint,
  createStory,
  createTask,
  createTaskFieldValue,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function convert(
  target: Target,
  taskId: string,
  kind: 'story' | 'epic',
  person: Person = target.member,
  requestEnv: Env = testEnv,
) {
  return post(app, taskConvert, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, kind },
    env: requestEnv,
  });
}

async function reasonOf(res: Response) {
  return ((await res.clone().json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
}

const dbOf = (target: Target) => orgDb(env, target.organization.verified);

async function rowsOf(target: Target, table: 'tasks' | 'stories' | 'epics') {
  const db = dbOf(target);
  return db.rows(db.statement((q) => q.selectFrom(table).selectAll().where('workspace_id', '=', target.workspace.id)));
}

async function conversionsOf(target: Target) {
  const db = dbOf(target);
  return db.rows(
    db.statement((q) => q.selectFrom('kind_conversions').selectAll().where('workspace_id', '=', target.workspace.id)),
  );
}

async function logsOf(target: Target, entityType: string, entityId: string) {
  const db = dbOf(target);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// 何も書かれていないこと（どの表にも先の行も対応も履歴も増えず、元のタスクも変わらない）
async function expectUntouched(target: Target, taskId: string) {
  expect(await conversionsOf(target)).toEqual([]);
  const stories = await rowsOf(target, 'stories');
  const epics = await rowsOf(target, 'epics');
  const tasks = await rowsOf(target, 'tasks');
  expect(tasks.find((t) => t.id === taskId)?.deleted_at).toBeNull();
  return { stories: stories.length, epics: epics.length };
}

describe('task-convert', () => {
  test('タスクをストーリーに変えると、題、本文、期日、リンク、作った人、区分が先に入り、元は削除され、対応と履歴が残る', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    const task = await createTask(target.organization, ws, target.member.userId!, {
      title: '見積もりを送る',
      body_md: '- 金額を確かめる',
      due_on: '2026-11-30',
      link_url: 'https://example.com/estimate',
      category_id: category.id,
      points: 3,
      assignee_user_id: target.leader.userId!,
      today_on: '2026-11-28',
    });

    const res = await convert(target, task.id, 'story');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id: string; kind: string; id: string };
    expect(body).toMatchObject({ task_id: task.id, kind: 'story' });

    const stories = await rowsOf(target, 'stories');
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({
      id: body.id,
      epic_id: null,
      title: '見積もりを送る',
      body_md: '- 金額を確かめる',
      due_on: '2026-11-30',
      link_url: 'https://example.com/estimate',
      category_id: category.id,
      created_by: target.member.userId,
      acceptance_criteria_md: null,
      completed_at: null,
      deleted_at: null,
    });

    const original = (await rowsOf(target, 'tasks')).find((t) => t.id === task.id)!;
    expect(original.deleted_at).not.toBeNull();

    expect(await conversionsOf(target)).toEqual([
      expect.objectContaining({
        workspace_id: ws,
        from_kind: 'task',
        from_id: task.id,
        to_kind: 'story',
        to_id: body.id,
        converted_by: target.member.userId,
      }),
    ]);

    const deleteLogs = await logsOf(target, 'task', task.id);
    expect(deleteLogs).toHaveLength(1);
    expect(deleteLogs[0]).toMatchObject({ action: 'delete', actor_user_id: target.member.userId });
    expect(JSON.parse(deleteLogs[0]!.changes_json)).toMatchObject({
      converted_to: [null, { id: body.id, kind: 'story' }],
    });
    const createLogs = await logsOf(target, 'story', body.id);
    expect(createLogs).toHaveLength(1);
    expect(createLogs[0]).toMatchObject({ action: 'create' });
    expect(JSON.parse(createLogs[0]!.changes_json)).toMatchObject({
      converted_from: [null, { id: task.id, kind: 'task' }],
    });
  });

  test('タスクをエピックに変えると、最上段の末尾に入り、依頼主は作った人になる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    await createEpic(target.organization, ws, target.admin.userId!, { position: 'a5' });
    const task = await createTask(target.organization, ws, target.member.userId!, { title: '制度を作る' });

    const res = await convert(target, task.id, 'epic');
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const epic = (await rowsOf(target, 'epics')).find((e) => e.id === id)!;
    expect(epic).toMatchObject({
      title: '制度を作る',
      created_by: target.member.userId,
      requester_user_id: target.member.userId,
      deleted_at: null,
    });
    expect(epic.position > 'a5').toBe(true);
    expect((await conversionsOf(target))[0]).toMatchObject({ to_kind: 'epic', to_id: id });
    expect((await logsOf(target, 'epic', id))[0]).toMatchObject({ action: 'create' });
  });

  test('ストーリーの下のタスクは、その親のエピックの下のストーリーの末尾に入り、区分は親から引き継ぐ', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    const epic = await createEpic(target.organization, ws, target.admin.userId!, { category_id: category.id });
    const parent = await createStory(target.organization, ws, target.admin.userId!, { epic_id: epic.id });
    await createStory(target.organization, ws, target.admin.userId!, { epic_id: epic.id, position: 'a8' });
    const task = await createTask(target.organization, ws, target.member.userId!, { story_id: parent.id });

    const res = await convert(target, task.id, 'story');
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const story = (await rowsOf(target, 'stories')).find((s) => s.id === id)!;
    // エピックの下のストーリーは区分を持たず、エピックから引き継ぐ
    expect(story).toMatchObject({ epic_id: epic.id, category_id: null });
    expect(story.position > 'a8').toBe(true);
  });

  test('親のあるタスクをエピックにすると、親から引き継いでいた区分を写して最上段に置く', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    const epic = await createEpic(target.organization, ws, target.admin.userId!, { category_id: category.id });
    const parent = await createStory(target.organization, ws, target.admin.userId!, { epic_id: epic.id });
    const task = await createTask(target.organization, ws, target.member.userId!, { story_id: parent.id });

    const { id } = (await (await convert(target, task.id, 'epic')).json()) as { id: string };
    expect((await rowsOf(target, 'epics')).find((e) => e.id === id)).toMatchObject({ category_id: category.id });
  });

  test('親のないストーリーの下のタスクは、親なしのストーリーの末尾に入り、そのストーリーの区分を写す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    const parent = await createStory(target.organization, ws, target.admin.userId!, { category_id: category.id });
    const task = await createTask(target.organization, ws, target.member.userId!, { story_id: parent.id });

    const { id } = (await (await convert(target, task.id, 'story')).json()) as { id: string };
    expect((await rowsOf(target, 'stories')).find((s) => s.id === id)).toMatchObject({
      epic_id: null,
      category_id: category.id,
    });
  });

  test('お気に入りが先の項目に付け替わる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const task = await createTask(target.organization, ws, target.member.userId!);
    const db = dbOf(target);
    await db.run(
      db.statement((q) =>
        q.insertInto('favorites').values({
          id: uuidv7(),
          user_id: target.leader.userId!,
          workspace_id: ws,
          task_id: task.id,
          created_at: '2026-11-01T00:00:00.000Z',
        }),
      ),
    );

    const { id } = (await (await convert(target, task.id, 'story')).json()) as { id: string };
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('favorites').selectAll().where('workspace_id', '=', ws)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: target.leader.userId, task_id: null, story_id: id, epic_id: null });
  });

  test('作った人でもリーダーでもない人は 403 で断られ、何も書かれない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: ws, role: 'member' },
    });
    const task = await createTask(target.organization, ws, target.member.userId!);

    expect((await convert(target, task.id, 'story', other)).status).toBe(403);
    await expectUntouched(target, task.id);
    // リーダーと管理者は変えられる
    expect((await convert(target, task.id, 'story', target.leader)).status).toBe(200);
  });

  test('別のワークスペースと別の組織の ID は、存在しないときと同じ 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const task = await createTask(foreign.organization, foreign.workspace.id, foreign.member.userId!);
    const here = await createTask(target.organization, target.otherWorkspace.id, target.bystander.userId!);

    expect((await convert(target, task.id, 'story')).status).toBe(404);
    expect((await convert(target, here.id, 'story')).status).toBe(404);
    expect((await convert(target, uuidv7(), 'story')).status).toBe(404);
    expect(await conversionsOf(foreign)).toEqual([]);
  });

  describe('断る条件', () => {
    async function expectRefused(target: Target, taskId: string, reason: string, kind: 'story' | 'epic' = 'story') {
      const before = await rowsOf(target, 'stories');
      const beforeEpics = await rowsOf(target, 'epics');
      const res = await convert(target, taskId, kind);
      expect(res.status).toBe(409);
      expect(await reasonOf(res)).toBe(reason);
      expect(await conversionsOf(target)).toEqual([]);
      expect(await rowsOf(target, 'stories')).toEqual(before);
      expect(await rowsOf(target, 'epics')).toEqual(beforeEpics);
      const task = (await rowsOf(target, 'tasks')).find((t) => t.id === taskId)!;
      expect(task.deleted_at).toBeNull();
      expect(await logsOf(target, 'task', taskId)).toEqual([]);
    }

    test('完了している', async () => {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        completed_at: '2026-11-20T00:00:00.000Z',
        completed_by: target.member.userId!,
      });
      await expectRefused(target, task.id, 'completed');
    });

    test('スプリントに入っている', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const sprint = await createSprint(target.organization, ws);
      const column = await createBoardColumn(target.organization, ws);
      const task = await createTask(target.organization, ws, target.member.userId!, {
        sprint_id: sprint.id,
        column_id: column.id,
        column_position: 'a0',
      });
      await expectRefused(target, task.id, 'in_sprint');
    });

    test('取り込んだタスク', async () => {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        is_imported: 1,
        created_by: null,
      });
      const res = await convert(target, task.id, 'story', target.leader);
      expect(res.status).toBe(409);
      expect(await reasonOf(res)).toBe('imported');
      expect(await conversionsOf(target)).toEqual([]);
    });

    test('コメントがある', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const task = await createTask(target.organization, ws, target.member.userId!);
      await createComment(target.organization, ws, task.id, target.leader.userId!);
      await expectRefused(target, task.id, 'has_comments');
    });

    test('削除したコメントだけなら変えられる', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const task = await createTask(target.organization, ws, target.member.userId!);
      await createComment(target.organization, ws, task.id, target.leader.userId!, {
        body_md: '',
        deleted_at: '2026-11-02T00:00:00.000Z',
        deleted_by: target.leader.userId!,
      });
      expect((await convert(target, task.id, 'story')).status).toBe(200);
    });

    test('添付がある', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const task = await createTask(target.organization, ws, target.member.userId!);
      await createAttachment(target.organization, ws, target.member.userId!, {
        task_id: task.id,
        attached_at: '2026-11-02T00:00:00.000Z',
      });
      await expectRefused(target, task.id, 'has_attachments');
    });

    test('決まった欄に値がある', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const task = await createTask(target.organization, ws, target.member.userId!);
      const field = await createDetailField(target.organization, ws);
      await createTaskFieldValue(target.organization, task.id, field.id, target.leader.userId!);
      await expectRefused(target, task.id, 'has_field_values');
    });

    test('置く先のエピックが完了している（ストーリーにするときだけ。エピックにするなら変えられる）', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const epic = await createEpic(target.organization, ws, target.admin.userId!, {
        completed_at: '2026-11-10T00:00:00.000Z',
        completed_by: target.admin.userId!,
      });
      const parent = await createStory(target.organization, ws, target.admin.userId!, {
        epic_id: epic.id,
        completed_at: '2026-11-10T00:00:00.000Z',
        completed_by: target.admin.userId!,
      });
      const task = await createTask(target.organization, ws, target.member.userId!, { story_id: parent.id });
      await expectRefused(target, task.id, 'parent_completed');
      expect((await convert(target, task.id, 'epic')).status).toBe(200);
    });

    test('削除したタスクは 404', async () => {
      const target = await createTarget();
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        deleted_at: '2026-11-02T00:00:00.000Z',
      });
      expect((await convert(target, task.id, 'story')).status).toBe(404);
    });
  });

  test('削除した欄の値だけが残るタスクは変えられる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const task = await createTask(target.organization, ws, target.member.userId!);
    const field = await createDetailField(target.organization, ws, { deleted_at: '2026-11-02T00:00:00.000Z' });
    await createTaskFieldValue(target.organization, task.id, field.id, target.leader.userId!);
    expect((await convert(target, task.id, 'story')).status).toBe(200);
  });

  test('変えた後にもう一度変えると 404 で、先の種類と ID が載る', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const { id } = (await (await convert(target, task.id, 'story')).json()) as { id: string };
    const again = await convert(target, task.id, 'epic');
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: { details?: unknown } }).error.details).toEqual({
      converted_to: { kind: 'story', id },
    });
  });

  test('権限の無い人には、変えられない理由より先に 403 を返す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: ws, role: 'member' },
    });
    const task = await createTask(target.organization, ws, target.member.userId!, {
      completed_at: '2026-11-20T00:00:00.000Z',
      completed_by: target.member.userId!,
    });
    expect((await convert(target, task.id, 'story', other)).status).toBe(403);
  });

  test('エピックに変えるときも、お気に入りは先のエピックへ付け替わる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const task = await createTask(target.organization, ws, target.member.userId!);
    const db = dbOf(target);
    await db.run(
      db.statement((q) =>
        q.insertInto('favorites').values({
          id: uuidv7(),
          user_id: target.leader.userId!,
          workspace_id: ws,
          task_id: task.id,
          created_at: '2026-11-01T00:00:00.000Z',
        }),
      ),
    );
    const { id } = (await (await convert(target, task.id, 'epic')).json()) as { id: string };
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('favorites').selectAll().where('workspace_id', '=', ws)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: null, story_id: null, epic_id: id });
  });

  test('親のストーリーが削除されているタスクは、親なしとして変えられる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const parent = await createStory(target.organization, ws, target.admin.userId!, {
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    const task = await createTask(target.organization, ws, target.member.userId!, { story_id: parent.id });
    const { id } = (await (await convert(target, task.id, 'story')).json()) as { id: string };
    expect((await rowsOf(target, 'stories')).find((s) => s.id === id)).toMatchObject({ epic_id: null });
  });

  test('リーダーが変えても、先の作った人は元の作った人で、変えた人は対応に残る。エピックの履歴と今日やるの印も確かめる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const task = await createTask(target.organization, ws, target.member.userId!, {
      today_on: '2026-11-28',
      title: '制度を作る',
    });
    const { id } = (await (await convert(target, task.id, 'epic', target.leader)).json()) as { id: string };
    expect((await rowsOf(target, 'epics')).find((e) => e.id === id)).toMatchObject({
      created_by: target.member.userId,
      requester_user_id: target.member.userId,
    });
    expect((await conversionsOf(target))[0]).toMatchObject({ converted_by: target.leader.userId });
    expect((await rowsOf(target, 'tasks')).find((t) => t.id === task.id)).toMatchObject({ today_on: null });
    const log = (await logsOf(target, 'epic', id))[0]!;
    expect(JSON.parse(log.changes_json)).toMatchObject({
      title: [null, '制度を作る'],
      converted_from: [null, { id: task.id, kind: 'task', title: '制度を作る' }],
    });
    expect(JSON.parse((await logsOf(target, 'task', task.id))[0]!.changes_json)).toMatchObject({
      converted_to: [null, { id, kind: 'epic' }],
    });
  });

  test('区分は、エピック、ストーリー、タスクの順に最初に入っているものを写し、削除された区分は引き継がない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const own = await createCategory(target.organization, ws, { name: '追加案件' });
    const fromStory = await createCategory(target.organization, ws, { name: '保守' });
    const gone = await createCategory(target.organization, ws, {
      name: '古い',
      deleted_at: '2026-11-02T00:00:00.000Z',
    });

    const story = await createStory(target.organization, ws, target.admin.userId!, { category_id: fromStory.id });
    const both = await createTask(target.organization, ws, target.member.userId!, {
      story_id: story.id,
      category_id: own.id,
    });
    const a = (await (await convert(target, both.id, 'epic')).json()) as { id: string };
    // ストーリーの区分がタスク自身より先
    expect((await rowsOf(target, 'epics')).find((e) => e.id === a.id)).toMatchObject({ category_id: fromStory.id });

    const deleted = await createTask(target.organization, ws, target.member.userId!, { category_id: gone.id });
    const b = (await (await convert(target, deleted.id, 'epic')).json()) as { id: string };
    expect((await rowsOf(target, 'epics')).find((e) => e.id === b.id)).toMatchObject({ category_id: null });
  });

  test('先の位置は、行き先の並びの削除していない最後の直後に入る', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const epic = await createEpic(target.organization, ws, target.admin.userId!);
    const other = await createEpic(target.organization, ws, target.admin.userId!, { position: 'a9' });
    await createStory(target.organization, ws, target.admin.userId!, { epic_id: epic.id, position: 'a3' });
    await createStory(target.organization, ws, target.admin.userId!, {
      epic_id: epic.id,
      position: 'a7',
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    await createStory(target.organization, ws, target.admin.userId!, { epic_id: other.id, position: 'a8' });
    const parent = await createStory(target.organization, ws, target.admin.userId!, {
      epic_id: epic.id,
      position: 'a1',
    });
    const task = await createTask(target.organization, ws, target.member.userId!, { story_id: parent.id });

    const { id } = (await (await convert(target, task.id, 'story')).json()) as { id: string };
    const row = (await rowsOf(target, 'stories')).find((s) => s.id === id)!;
    expect(row.epic_id).toBe(epic.id);
    expect(row.position > 'a3' && row.position < 'a7').toBe(true);
  });

  test('置く先のエピックだけが完了しているときは断り、ストーリーだけが完了していても変えられる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const doneAt = { completed_at: '2026-11-10T00:00:00.000Z', completed_by: target.admin.userId! };
    const doneEpic = await createEpic(target.organization, ws, target.admin.userId!, doneAt);
    const openParent = await createStory(target.organization, ws, target.admin.userId!, { epic_id: doneEpic.id });
    const blocked = await createTask(target.organization, ws, target.member.userId!, { story_id: openParent.id });
    expect(await reasonOf(await convert(target, blocked.id, 'story'))).toBe('parent_completed');

    const openEpic = await createEpic(target.organization, ws, target.admin.userId!);
    const doneParent = await createStory(target.organization, ws, target.admin.userId!, {
      epic_id: openEpic.id,
      ...doneAt,
    });
    const ok = await createTask(target.organization, ws, target.member.userId!, {
      story_id: doneParent.id,
      completed_at: null,
    });
    expect((await convert(target, ok.id, 'story')).status).toBe(200);
  });

  test('変えたタスクの task-restore は、元の親が完了していても converted で断る', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const parent = await createStory(target.organization, ws, target.admin.userId!);
    const task = await createTask(target.organization, ws, target.member.userId!, { story_id: parent.id });
    expect((await convert(target, task.id, 'epic')).status).toBe(200);
    const db = dbOf(target);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ completed_at: '2026-11-10T00:00:00.000Z', completed_by: target.admin.userId! })
          .where('id', '=', parent.id),
      ),
    );
    const res = await post(app, taskRestore, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: ws, task_id: task.id },
    });
    expect(await reasonOf(res)).toBe('converted');
  });

  test('同じタスクを同時に2回変えても、行き先は1つだけできる', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);

    const [a, b] = await Promise.all([convert(target, task.id, 'story'), convert(target, task.id, 'story')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // 負けた側の 409 にも、先に通った要求の先の種類と ID が載る
    const loser = a.status === 409 ? a : b;
    const winner = (await (a.status === 200 ? a : b).json()) as { id: string };
    expect(((await loser.json()) as { error: { details?: unknown } }).error.details).toEqual({
      reason: 'changed',
      converted_to: { kind: 'story', id: winner.id },
    });
    expect(await rowsOf(target, 'stories')).toHaveLength(1);
    expect(await conversionsOf(target)).toHaveLength(1);
    expect(await logsOf(target, 'task', task.id)).toHaveLength(1);
  });

  test('読んでから書くまでにコメントが付いたら、何も書かずに 409 を返す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const task = await createTask(target.organization, ws, target.member.userId!);
    let done = false;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !sql.includes('from "tasks" left join "stories"')) return;
        done = true;
        await createComment(target.organization, ws, task.id, target.leader.userId!);
      },
    });

    const res = await convert(target, task.id, 'story', target.member, racing);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('has_comments');
    expect(await conversionsOf(target)).toEqual([]);
    expect(await rowsOf(target, 'stories')).toEqual([]);
    expect((await rowsOf(target, 'tasks')).find((t) => t.id === task.id)?.deleted_at).toBeNull();
  });

  test('種類を変えたタスクの task-restore は 409（converted）で断られ、削除の取り消しにならない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await convert(target, task.id, 'story')).status).toBe(200);

    const res = await post(app, taskRestore, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, task_id: task.id },
    });
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('converted');
    expect((await rowsOf(target, 'tasks')).find((t) => t.id === task.id)?.deleted_at).not.toBeNull();
  });

  test('種類を変えたタスクの task-detail は 404 で、先の種類と ID が載る。変えていない削除済みには載らない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const task = await createTask(target.organization, ws, target.member.userId!);
    const { id } = (await (await convert(target, task.id, 'epic')).json()) as { id: string };

    const detail = (taskId: string) =>
      post(app, taskDetail, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: ws, task_id: taskId },
      });
    const res = await detail(task.id);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { details?: unknown } }).error.details).toEqual({
      converted_to: { kind: 'epic', id },
    });

    // 別のワークスペースの人が、自分のワークスペースの ID で引いても、先の種類と ID は載らない
    const other = await post(app, taskDetail, {
      slug: target.slug,
      token: target.bystander.token,
      body: { workspace_id: target.otherWorkspace.id, task_id: task.id },
    });
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: { details?: unknown } }).error.details).toBeUndefined();

    const deleted = await createTask(target.organization, ws, target.member.userId!, {
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    const plain = await detail(deleted.id);
    expect(plain.status).toBe(404);
    expect(((await plain.json()) as { error: { details?: unknown } }).error.details).toBeUndefined();
  });
});
