// ストーリーとエピックの種類の変更（story-convert、epic-convert）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。書き方は test/task-convert.test.ts と同じ
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { epicConvert, epicDetail, epicGet } from '../src/shared/operations/epic/index.ts';
import { storyConvert, storyGet } from '../src/shared/operations/story/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { uuidv7 } from '../src/server/uuid.ts';
import { createCategory, createEpic, createStory, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function convertStory(
  target: Target,
  storyId: string,
  kind: 'task' | 'epic',
  person: Person = target.member,
  requestEnv: Env = testEnv,
) {
  return post(app, storyConvert, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId, kind },
    env: requestEnv,
  });
}

function convertEpic(
  target: Target,
  epicId: string,
  kind: 'story' | 'task',
  person: Person = target.member,
  requestEnv: Env = testEnv,
) {
  return post(app, epicConvert, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId, kind },
    env: requestEnv,
  });
}

async function reasonOf(res: Response) {
  return ((await res.clone().json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
}

async function detailsOf(res: Response) {
  return ((await res.clone().json()) as { error: { details?: unknown } }).error.details;
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

async function addFavorite(target: Target, column: 'task_id' | 'story_id' | 'epic_id', id: string) {
  const db = dbOf(target);
  await db.run(
    db.statement((q) =>
      q.insertInto('favorites').values({
        id: uuidv7(),
        user_id: target.leader.userId!,
        workspace_id: target.workspace.id,
        [column]: id,
        created_at: '2026-11-01T00:00:00.000Z',
      }),
    ),
  );
  return db;
}

describe('story-convert', () => {
  test('ストーリーをタスクに変えると、題、本文、期日、リンク、作った人、区分が先に入り、元は削除され、対応と履歴が残る', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    await createTask(target.organization, ws, target.admin.userId!, { position: 'a5' });
    const story = await createStory(target.organization, ws, target.member.userId!, {
      title: '見積もりを整える',
      body_md: '- 金額を確かめる',
      due_on: '2026-11-30',
      link_url: 'https://example.com/estimate',
      category_id: category.id,
    });

    const res = await convertStory(target, story.id, 'task');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { story_id: string; kind: string; id: string };
    expect(body).toMatchObject({ story_id: story.id, kind: 'task' });

    const task = (await rowsOf(target, 'tasks')).find((t) => t.id === body.id)!;
    expect(task).toMatchObject({
      story_id: null,
      tray: 'backlog',
      is_imported: 0,
      title: '見積もりを整える',
      body_md: '- 金額を確かめる',
      due_on: '2026-11-30',
      link_url: 'https://example.com/estimate',
      category_id: category.id,
      created_by: target.member.userId,
      points: null,
      assignee_user_id: null,
      sprint_id: null,
      completed_at: null,
      deleted_at: null,
    });
    expect(task.position > 'a5').toBe(true);
    expect((await rowsOf(target, 'stories')).find((s) => s.id === story.id)?.deleted_at).not.toBeNull();

    expect(await conversionsOf(target)).toEqual([
      expect.objectContaining({
        workspace_id: ws,
        from_kind: 'story',
        from_id: story.id,
        to_kind: 'task',
        to_id: body.id,
        converted_by: target.member.userId,
      }),
    ]);
    const deleteLogs = await logsOf(target, 'story', story.id);
    expect(deleteLogs).toHaveLength(1);
    expect(deleteLogs[0]).toMatchObject({ action: 'delete', actor_user_id: target.member.userId });
    expect(JSON.parse(deleteLogs[0]!.changes_json)).toMatchObject({
      converted_to: [null, { id: body.id, kind: 'task' }],
    });
    const createLogs = await logsOf(target, 'task', body.id);
    expect(createLogs).toHaveLength(1);
    expect(createLogs[0]).toMatchObject({ action: 'create' });
    expect(JSON.parse(createLogs[0]!.changes_json)).toMatchObject({
      converted_from: [null, { id: story.id, kind: 'story' }],
    });
  });

  test('ストーリーをエピックに変えると、最上段の末尾に入り、依頼主は作った人になる。報酬の段階は書かない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    await createEpic(target.organization, ws, target.admin.userId!, { position: 'a5' });
    const story = await createStory(target.organization, ws, target.member.userId!, { title: '制度を作る' });

    const res = await convertStory(target, story.id, 'epic');
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const epic = (await rowsOf(target, 'epics')).find((e) => e.id === id)!;
    expect(epic).toMatchObject({
      title: '制度を作る',
      created_by: target.member.userId,
      requester_user_id: target.member.userId,
      reward_tier: null,
      deleted_at: null,
    });
    expect(epic.position > 'a5').toBe(true);
    expect((await conversionsOf(target))[0]).toMatchObject({ from_kind: 'story', to_kind: 'epic', to_id: id });
    expect((await logsOf(target, 'epic', id))[0]).toMatchObject({ action: 'create' });
  });

  test('受け入れ基準は、先の本文の末尾に見出しつきで入る。本文が空なら見出しから始まる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const withBody = await createStory(target.organization, ws, target.member.userId!, {
      body_md: '背景を書く',
      acceptance_criteria_md: '- [ ] 金額が出る',
    });
    const noBody = await createStory(target.organization, ws, target.member.userId!, {
      acceptance_criteria_md: '- [ ] 送れる',
    });
    const noCriteria = await createStory(target.organization, ws, target.member.userId!, { body_md: '本文だけ' });

    const a = (await (await convertStory(target, withBody.id, 'task')).json()) as { id: string };
    const b = (await (await convertStory(target, noBody.id, 'epic')).json()) as { id: string };
    const c = (await (await convertStory(target, noCriteria.id, 'task')).json()) as { id: string };

    const tasks = await rowsOf(target, 'tasks');
    expect(tasks.find((t) => t.id === a.id)?.body_md).toBe('背景を書く\n\n## 受け入れ基準\n\n- [ ] 金額が出る');
    expect((await rowsOf(target, 'epics')).find((e) => e.id === b.id)?.body_md).toBe('## 受け入れ基準\n\n- [ ] 送れる');
    expect(tasks.find((t) => t.id === c.id)?.body_md).toBe('本文だけ');
    // 履歴の先の本文も、写した後の値
    expect(JSON.parse((await logsOf(target, 'task', a.id))[0]!.changes_json).body_md).toEqual([
      null,
      '背景を書く\n\n## 受け入れ基準\n\n- [ ] 金額が出る',
    ]);
  });

  test('受け入れ基準を写すと本文が 1 万字を超えるときは 409（too_long）で断り、何も書かない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const story = await createStory(target.organization, ws, target.member.userId!, {
      body_md: 'あ'.repeat(9_990),
      acceptance_criteria_md: 'い'.repeat(100),
    });

    const res = await convertStory(target, story.id, 'task');
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('too_long');
    expect(await conversionsOf(target)).toEqual([]);
    expect(await rowsOf(target, 'tasks')).toEqual([]);
    expect((await rowsOf(target, 'stories')).find((s) => s.id === story.id)?.deleted_at).toBeNull();

    // 写した後がちょうど 1 万字なら通る（見出しと空行の 13 字を含む）
    const fit = await createStory(target.organization, ws, target.member.userId!, {
      body_md: 'あ'.repeat(9_887),
      acceptance_criteria_md: 'い'.repeat(100),
    });
    expect((await convertStory(target, fit.id, 'task')).status).toBe(200);
    // 受け入れ基準が無ければ、本文が上限ちょうどでも通る
    const plain = await createStory(target.organization, ws, target.member.userId!, { body_md: 'あ'.repeat(10_000) });
    expect((await convertStory(target, plain.id, 'task')).status).toBe(200);
  });

  test('エピックの下のストーリーは、区分をエピックから引き継ぎ、親なしで最上段に入る', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    const epic = await createEpic(target.organization, ws, target.admin.userId!, { category_id: category.id });
    const story = await createStory(target.organization, ws, target.member.userId!, { epic_id: epic.id });

    const { id } = (await (await convertStory(target, story.id, 'task')).json()) as { id: string };
    expect((await rowsOf(target, 'tasks')).find((t) => t.id === id)).toMatchObject({
      story_id: null,
      category_id: category.id,
    });
    // 元のエピックは変わらない
    expect((await rowsOf(target, 'epics')).find((e) => e.id === epic.id)?.deleted_at).toBeNull();
  });

  test('削除された区分は引き継がない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws, { deleted_at: '2026-11-02T00:00:00.000Z' });
    const story = await createStory(target.organization, ws, target.member.userId!, { category_id: category.id });

    const { id } = (await (await convertStory(target, story.id, 'epic')).json()) as { id: string };
    expect((await rowsOf(target, 'epics')).find((e) => e.id === id)?.category_id).toBeNull();
  });

  test('お気に入りが先の項目に付け替わる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const story = await createStory(target.organization, ws, target.member.userId!);
    const db = await addFavorite(target, 'story_id', story.id);

    const { id } = (await (await convertStory(target, story.id, 'epic')).json()) as { id: string };
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('favorites').selectAll().where('workspace_id', '=', ws)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: null, story_id: null, epic_id: id });
  });

  test('作った人でもリーダーでもない人は 403 で断られ、何も書かれない。リーダーは変えられる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: ws, role: 'member' },
    });
    const story = await createStory(target.organization, ws, target.member.userId!);

    expect((await convertStory(target, story.id, 'task', other)).status).toBe(403);
    expect(await conversionsOf(target)).toEqual([]);
    expect((await rowsOf(target, 'stories')).find((s) => s.id === story.id)?.deleted_at).toBeNull();
    expect((await convertStory(target, story.id, 'task', target.leader)).status).toBe(200);
  });

  test('別のワークスペースと別の組織の ID は、存在しないときと同じ 404（先の種類も載らない）', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const theirs = await createStory(foreign.organization, foreign.workspace.id, foreign.member.userId!);
    const here = await createStory(target.organization, target.otherWorkspace.id, target.bystander.userId!);

    for (const id of [theirs.id, here.id, uuidv7()]) {
      const res = await convertStory(target, id, 'task');
      expect(res.status).toBe(404);
      expect(await detailsOf(res)).toBeUndefined();
    }
    expect(await conversionsOf(foreign)).toEqual([]);
  });

  describe('断る条件', () => {
    async function expectRefused(target: Target, storyId: string, reason: string) {
      const res = await convertStory(target, storyId, 'task');
      expect(res.status).toBe(409);
      expect(await reasonOf(res)).toBe(reason);
      expect(await conversionsOf(target)).toEqual([]);
      expect(await rowsOf(target, 'tasks').then((rows) => rows.filter((t) => t.title === '見積もりを整える'))).toEqual(
        [],
      );
      expect(await rowsOf(target, 'epics')).toEqual(
        (await rowsOf(target, 'epics')).filter((e) => e.deleted_at === null),
      );
      expect((await rowsOf(target, 'stories')).find((s) => s.id === storyId)?.deleted_at).toBeNull();
      expect(await logsOf(target, 'story', storyId)).toEqual([]);
    }

    test('完了している', async () => {
      const target = await createTarget();
      const story = await createStory(target.organization, target.workspace.id, target.member.userId!, {
        title: '見積もりを整える',
        completed_at: '2026-11-20T00:00:00.000Z',
        completed_by: target.member.userId!,
      });
      await expectRefused(target, story.id, 'completed');
    });

    test('配下にタスクがある（完了したタスクも数える）', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const story = await createStory(target.organization, ws, target.member.userId!, { title: '見積もりを整える' });
      await createTask(target.organization, ws, target.member.userId!, {
        story_id: story.id,
        completed_at: '2026-11-20T00:00:00.000Z',
        completed_by: target.member.userId!,
      });
      await expectRefused(target, story.id, 'has_children');
    });

    test('削除したタスクだけが残るストーリーは変えられる', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const story = await createStory(target.organization, ws, target.member.userId!);
      await createTask(target.organization, ws, target.member.userId!, {
        story_id: story.id,
        deleted_at: '2026-11-02T00:00:00.000Z',
      });
      expect((await convertStory(target, story.id, 'task')).status).toBe(200);
    });

    test('親のエピックが完了している（行き先がエピックでも断る）', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const epic = await createEpic(target.organization, ws, target.admin.userId!, {
        completed_at: '2026-11-20T00:00:00.000Z',
        completed_by: target.admin.userId!,
      });
      const story = await createStory(target.organization, ws, target.member.userId!, {
        title: '見積もりを整える',
        epic_id: epic.id,
      });
      await expectRefused(target, story.id, 'parent_completed');
      const res = await convertStory(target, story.id, 'epic');
      expect(await reasonOf(res)).toBe('parent_completed');
    });

    test('削除したストーリーは 404', async () => {
      const target = await createTarget();
      const story = await createStory(target.organization, target.workspace.id, target.member.userId!, {
        deleted_at: '2026-11-02T00:00:00.000Z',
      });
      const res = await convertStory(target, story.id, 'task');
      expect(res.status).toBe(404);
      expect(await detailsOf(res)).toBeUndefined();
    });
  });

  test('権限の無い人には、変えられない理由より先に 403 を返す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: ws, role: 'member' },
    });
    const story = await createStory(target.organization, ws, target.member.userId!, {
      completed_at: '2026-11-20T00:00:00.000Z',
      completed_by: target.member.userId!,
    });
    expect((await convertStory(target, story.id, 'task', other)).status).toBe(403);
  });

  test('変えた後にもう一度変えると 404 で、先の種類と ID が載る。story-get も同じ', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const story = await createStory(target.organization, ws, target.member.userId!);
    const { id } = (await (await convertStory(target, story.id, 'task')).json()) as { id: string };

    const again = await convertStory(target, story.id, 'epic');
    expect(again.status).toBe(404);
    expect(await detailsOf(again)).toEqual({ converted_to: { kind: 'task', id } });

    const get = (person: Person, workspaceId: string) =>
      post(app, storyGet, {
        slug: target.slug,
        token: person.token,
        body: { workspace_id: workspaceId, story_id: story.id },
      });
    const res = await get(target.member, ws);
    expect(res.status).toBe(404);
    expect(await detailsOf(res)).toEqual({ converted_to: { kind: 'task', id } });
    // 別のワークスペースの人が引いても、先は載らない
    const other = await get(target.bystander, target.otherWorkspace.id);
    expect(other.status).toBe(404);
    expect(await detailsOf(other)).toBeUndefined();
    // 変えていない削除済みにも載らない
    const deleted = await createStory(target.organization, ws, target.member.userId!, {
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    const plain = await post(app, storyGet, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: ws, story_id: deleted.id },
    });
    expect(plain.status).toBe(404);
    expect(await detailsOf(plain)).toBeUndefined();
  });

  test('1 万字の数え方はコードポイントで、UTF-16 の長さでは数えない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    // 写した後は 5,013 コードポイント（UTF-16 では 10,013）。上限以下なので通る
    const ok = await createStory(target.organization, ws, target.member.userId!, {
      body_md: '😀'.repeat(4_900),
      acceptance_criteria_md: '😀'.repeat(100),
    });
    expect((await convertStory(target, ok.id, 'task')).status).toBe(200);
    // 写した後は 10,013 コードポイント。上限を超えるので断る（見出しの 13 字も数える）。数え方の違いは見分けない（どちらでも超える）。区別するのは上の ok の側
    const over = await createStory(target.organization, ws, target.member.userId!, {
      body_md: '😀'.repeat(9_000),
      acceptance_criteria_md: '😀'.repeat(1_000),
    });
    const res = await convertStory(target, over.id, 'task');
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('too_long');
    // 写した後がちょうど 10,001 コードポイントなら断る（上限の 1 字上）
    const edge = await createStory(target.organization, ws, target.member.userId!, {
      body_md: 'あ'.repeat(9_888),
      acceptance_criteria_md: 'い'.repeat(100),
    });
    expect(await reasonOf(await convertStory(target, edge.id, 'task'))).toBe('too_long');
    // 写す前は上限以下で、見出しを足すと超える
    const heading = await createStory(target.organization, ws, target.member.userId!, {
      body_md: 'あ'.repeat(9_900),
      acceptance_criteria_md: 'い'.repeat(95),
    });
    expect(await reasonOf(await convertStory(target, heading.id, 'task'))).toBe('too_long');
  });

  test('親のエピックが削除済みのストーリーは、ストーリー自身の区分を写して変えられる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    const epic = await createEpic(target.organization, ws, target.admin.userId!, {
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    const story = await createStory(target.organization, ws, target.member.userId!, {
      epic_id: epic.id,
      category_id: category.id,
    });
    const res = await convertStory(target, story.id, 'task');
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect((await rowsOf(target, 'tasks')).find((t) => t.id === id)?.category_id).toBe(category.id);
  });

  test('読んでから書くまでに親のエピックが完了したら、何も書かずに 409 を返す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const epic = await createEpic(target.organization, ws, target.admin.userId!);
    const story = await createStory(target.organization, ws, target.member.userId!, { epic_id: epic.id });
    let done = false;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !sql.includes('as "has_children"')) return;
        done = true;
        const db = dbOf(target);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('epics')
              .set({ completed_at: '2026-11-20T00:00:00.000Z', completed_by: target.admin.userId! })
              .where('id', '=', epic.id),
          ),
        );
      },
    });
    const res = await convertStory(target, story.id, 'task', target.member, racing);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('parent_completed');
    expect(await conversionsOf(target)).toEqual([]);
    expect((await rowsOf(target, 'stories')).find((s) => s.id === story.id)?.deleted_at).toBeNull();
  });

  test('同じストーリーを同時に2回変えても、行き先は1つだけできる', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.member.userId!);

    const [a, b] = await Promise.all([convertStory(target, story.id, 'task'), convertStory(target, story.id, 'task')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = (await (a.status === 200 ? a : b).json()) as { id: string };
    expect(await detailsOf(loser)).toEqual({ reason: 'changed', converted_to: { kind: 'task', id: winner.id } });
    expect(await rowsOf(target, 'tasks')).toHaveLength(1);
    expect(await conversionsOf(target)).toHaveLength(1);
    expect(await logsOf(target, 'story', story.id)).toHaveLength(1);
  });

  test('読んでから書くまでに配下のタスクが付いたら、何も書かずに 409（has_children）を返す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const story = await createStory(target.organization, ws, target.member.userId!);
    let done = false;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !sql.includes('as "has_children"')) return;
        done = true;
        await createTask(target.organization, ws, target.member.userId!, { story_id: story.id });
      },
    });

    const res = await convertStory(target, story.id, 'task', target.member, racing);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('has_children');
    expect(await conversionsOf(target)).toEqual([]);
    expect((await rowsOf(target, 'stories')).find((s) => s.id === story.id)?.deleted_at).toBeNull();
    expect(await rowsOf(target, 'tasks')).toHaveLength(1);
  });
});

describe('epic-convert', () => {
  test('エピックをストーリーに変えると、題、本文、期日、リンク、作った人、区分が先に入り、元は削除され、対応と履歴が残る', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const category = await createCategory(target.organization, ws);
    await createStory(target.organization, ws, target.admin.userId!, { position: 'a5' });
    const epic = await createEpic(target.organization, ws, target.member.userId!, {
      title: '制度を公開する',
      body_md: '- 告知する',
      due_on: '2026-12-31',
      link_url: 'https://example.com/launch',
      category_id: category.id,
      requester_user_id: target.leader.userId!,
    });

    const res = await convertEpic(target, epic.id, 'story');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { epic_id: string; kind: string; id: string };
    expect(body).toMatchObject({ epic_id: epic.id, kind: 'story' });

    const story = (await rowsOf(target, 'stories')).find((s) => s.id === body.id)!;
    expect(story).toMatchObject({
      epic_id: null,
      title: '制度を公開する',
      body_md: '- 告知する',
      acceptance_criteria_md: null,
      due_on: '2026-12-31',
      link_url: 'https://example.com/launch',
      category_id: category.id,
      created_by: target.member.userId,
      completed_at: null,
      deleted_at: null,
    });
    expect(story.position > 'a5').toBe(true);
    expect((await rowsOf(target, 'epics')).find((e) => e.id === epic.id)?.deleted_at).not.toBeNull();
    expect(await conversionsOf(target)).toEqual([
      expect.objectContaining({
        from_kind: 'epic',
        from_id: epic.id,
        to_kind: 'story',
        to_id: body.id,
        converted_by: target.member.userId,
      }),
    ]);
    expect((await logsOf(target, 'epic', epic.id))[0]).toMatchObject({ action: 'delete' });
    expect(JSON.parse((await logsOf(target, 'epic', epic.id))[0]!.changes_json)).toMatchObject({
      converted_to: [null, { id: body.id, kind: 'story' }],
    });
    expect(JSON.parse((await logsOf(target, 'story', body.id))[0]!.changes_json)).toMatchObject({
      converted_from: [null, { id: epic.id, kind: 'epic' }],
    });
  });

  test('エピックをタスクに変えると、親のないタスクの末尾に入り、未着手で担当とポイントは空', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    await createTask(target.organization, ws, target.admin.userId!, { position: 'a5' });
    const epic = await createEpic(target.organization, ws, target.member.userId!, { title: '制度を公開する' });

    const { id } = (await (await convertEpic(target, epic.id, 'task')).json()) as { id: string };
    const task = (await rowsOf(target, 'tasks')).find((t) => t.id === id)!;
    expect(task).toMatchObject({
      story_id: null,
      tray: 'backlog',
      title: '制度を公開する',
      created_by: target.member.userId,
      points: null,
      assignee_user_id: null,
      completed_at: null,
      deleted_at: null,
    });
    expect(task.position > 'a5').toBe(true);
    expect((await logsOf(target, 'task', id))[0]).toMatchObject({ action: 'create' });
  });

  test('お気に入りが先の項目に付け替わる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const epic = await createEpic(target.organization, ws, target.member.userId!);
    const db = await addFavorite(target, 'epic_id', epic.id);

    const { id } = (await (await convertEpic(target, epic.id, 'task')).json()) as { id: string };
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('favorites').selectAll().where('workspace_id', '=', ws)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: id, story_id: null, epic_id: null });
  });

  test('作った人でもリーダーでもない人は 403 で断られ、何も書かれない。リーダーは変えられる', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: ws, role: 'member' },
    });
    const epic = await createEpic(target.organization, ws, target.member.userId!);

    expect((await convertEpic(target, epic.id, 'story', other)).status).toBe(403);
    expect(await conversionsOf(target)).toEqual([]);
    expect((await rowsOf(target, 'epics')).find((e) => e.id === epic.id)?.deleted_at).toBeNull();
    expect((await convertEpic(target, epic.id, 'story', target.leader)).status).toBe(200);
  });

  test('別のワークスペースと別の組織の ID は、存在しないときと同じ 404（先の種類も載らない）', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const theirs = await createEpic(foreign.organization, foreign.workspace.id, foreign.member.userId!);
    const here = await createEpic(target.organization, target.otherWorkspace.id, target.bystander.userId!);

    for (const id of [theirs.id, here.id, uuidv7()]) {
      const res = await convertEpic(target, id, 'story');
      expect(res.status).toBe(404);
      expect(await detailsOf(res)).toBeUndefined();
    }
    expect(await conversionsOf(foreign)).toEqual([]);
  });

  describe('断る条件', () => {
    test('クリア済み', async () => {
      const target = await createTarget();
      const epic = await createEpic(target.organization, target.workspace.id, target.member.userId!, {
        completed_at: '2026-11-20T00:00:00.000Z',
        completed_by: target.member.userId!,
      });
      const res = await convertEpic(target, epic.id, 'story');
      expect(res.status).toBe(409);
      expect(await reasonOf(res)).toBe('completed');
      expect(await conversionsOf(target)).toEqual([]);
      expect(await rowsOf(target, 'stories')).toEqual([]);
    });

    test('配下にストーリーがある（完了したストーリーも数える）', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const epic = await createEpic(target.organization, ws, target.member.userId!);
      await createStory(target.organization, ws, target.admin.userId!, {
        epic_id: epic.id,
        completed_at: '2026-11-20T00:00:00.000Z',
        completed_by: target.admin.userId!,
      });
      const res = await convertEpic(target, epic.id, 'task');
      expect(res.status).toBe(409);
      expect(await reasonOf(res)).toBe('has_children');
      expect(await conversionsOf(target)).toEqual([]);
      expect(await rowsOf(target, 'tasks')).toEqual([]);
      expect((await rowsOf(target, 'epics')).find((e) => e.id === epic.id)?.deleted_at).toBeNull();
      expect(await logsOf(target, 'epic', epic.id)).toEqual([]);
    });

    test('削除したストーリーだけが残るエピックは変えられる', async () => {
      const target = await createTarget();
      const ws = target.workspace.id;
      const epic = await createEpic(target.organization, ws, target.member.userId!);
      await createStory(target.organization, ws, target.admin.userId!, {
        epic_id: epic.id,
        deleted_at: '2026-11-02T00:00:00.000Z',
      });
      expect((await convertEpic(target, epic.id, 'story')).status).toBe(200);
    });

    test('削除したエピックは 404', async () => {
      const target = await createTarget();
      const epic = await createEpic(target.organization, target.workspace.id, target.member.userId!, {
        deleted_at: '2026-11-02T00:00:00.000Z',
      });
      const res = await convertEpic(target, epic.id, 'story');
      expect(res.status).toBe(404);
      expect(await detailsOf(res)).toBeUndefined();
    });
  });

  test('変えた後にもう一度変えると 404 で、先の種類と ID が載る。epic-get と epic-detail も同じ', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const epic = await createEpic(target.organization, ws, target.member.userId!);
    const { id } = (await (await convertEpic(target, epic.id, 'story')).json()) as { id: string };

    const again = await convertEpic(target, epic.id, 'task');
    expect(again.status).toBe(404);
    expect(await detailsOf(again)).toEqual({ converted_to: { kind: 'story', id } });

    for (const operation of [epicGet, epicDetail]) {
      const res = await post(app, operation, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: ws, epic_id: epic.id },
      });
      expect(res.status).toBe(404);
      expect(await detailsOf(res)).toEqual({ converted_to: { kind: 'story', id } });
      // 別のワークスペースの人が引いても、先は載らない
      const other = await post(app, operation, {
        slug: target.slug,
        token: target.bystander.token,
        body: { workspace_id: target.otherWorkspace.id, epic_id: epic.id },
      });
      expect(other.status).toBe(404);
      expect(await detailsOf(other)).toBeUndefined();
    }
    // 変えていない削除済みにも載らない
    const deleted = await createEpic(target.organization, ws, target.member.userId!, {
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    const plain = await post(app, epicDetail, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: ws, epic_id: deleted.id },
    });
    expect(plain.status).toBe(404);
    expect(await detailsOf(plain)).toBeUndefined();
  });

  test('区分は写し（履歴にも残り）、削除された区分は引き継がない', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const live = await createCategory(target.organization, ws);
    const gone = await createCategory(target.organization, ws, { deleted_at: '2026-11-02T00:00:00.000Z' });
    const withLive = await createEpic(target.organization, ws, target.member.userId!, { category_id: live.id });
    const withGone = await createEpic(target.organization, ws, target.member.userId!, { category_id: gone.id });

    const a = (await (await convertEpic(target, withLive.id, 'story')).json()) as { id: string };
    const b = (await (await convertEpic(target, withGone.id, 'task')).json()) as { id: string };
    expect((await rowsOf(target, 'stories')).find((s) => s.id === a.id)?.category_id).toBe(live.id);
    expect(JSON.parse((await logsOf(target, 'story', a.id))[0]!.changes_json).category).toEqual([
      null,
      { id: live.id, name: live.name },
    ]);
    expect((await rowsOf(target, 'tasks')).find((t) => t.id === b.id)?.category_id).toBeNull();
    expect(JSON.parse((await logsOf(target, 'task', b.id))[0]!.changes_json).category).toBeUndefined();
  });

  test('同じエピックを同時に2回変えても、行き先は1つだけできる', async () => {
    const target = await createTarget();
    const epic = await createEpic(target.organization, target.workspace.id, target.member.userId!);

    const [a, b] = await Promise.all([convertEpic(target, epic.id, 'story'), convertEpic(target, epic.id, 'story')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = (await (a.status === 200 ? a : b).json()) as { id: string };
    expect(await detailsOf(loser)).toEqual({ reason: 'changed', converted_to: { kind: 'story', id: winner.id } });
    expect(await rowsOf(target, 'stories')).toHaveLength(1);
    expect(await conversionsOf(target)).toHaveLength(1);
    expect(await logsOf(target, 'epic', epic.id)).toHaveLength(1);
  });

  test('読んでから書くまでに配下のストーリーが付いたら、何も書かずに 409（has_children）を返す', async () => {
    const target = await createTarget();
    const ws = target.workspace.id;
    const epic = await createEpic(target.organization, ws, target.member.userId!);
    let done = false;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !sql.includes('as "has_children"')) return;
        done = true;
        await createStory(target.organization, ws, target.admin.userId!, { epic_id: epic.id });
      },
    });

    const res = await convertEpic(target, epic.id, 'story', target.member, racing);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('has_children');
    expect(await conversionsOf(target)).toEqual([]);
    expect((await rowsOf(target, 'epics')).find((e) => e.id === epic.id)?.deleted_at).toBeNull();
    expect(await rowsOf(target, 'stories')).toHaveLength(1);
  });
});
