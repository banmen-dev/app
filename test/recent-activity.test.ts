// 組織のホームの「最近の更新」（recent-activity）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
// ここでは、どの行が返るか（所属、閉じたワークスペース、権限の範囲、消した行）、混ぜた並び、本文の切り方、カーソルを確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { OutputOf } from '../src/shared/operations/define.ts';
import {
  RECENT_ACTIVITY_BODY_LENGTH,
  RECENT_ACTIVITY_PAGE_SIZE,
  recentActivity,
} from '../src/shared/operations/organization/recent-activity.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { queryPlanForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { recentChangesStatement, recentCommentsStatement } from '../src/server/operations/recent-activity.ts';
import {
  createChangeLog,
  createComment,
  createEpic,
  createMembership,
  createStory,
  createTask,
  uuidv7,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Activity = OutputOf<typeof recentActivity>;
type Cursor = NonNullable<Activity['next']>;

function call(target: Target, person: Person, body: unknown = {}) {
  return post(app, recentActivity, { slug: target.slug, token: person.token, body });
}

async function read(target: Target, person: Person, before?: Cursor): Promise<Activity> {
  const res = await call(target, person, before === undefined ? {} : { before });
  expect(res.status).toBe(200);
  return (await res.json()) as Activity;
}

// 2030-01-01T00:00:00.000Z から minutes 分後
function minutesLater(minutes: number): string {
  return new Date(Date.UTC(2030, 0, 1) + minutes * 60_000).toISOString();
}

type LogOptions = {
  target: Target;
  workspaceId?: string;
  entityType?: string;
  entityId: string;
  action?: string;
  changes?: Record<string, unknown>;
  at: string;
  actorUserId?: string | null;
};

function log(options: LogOptions) {
  return createChangeLog(options.target.organization, {
    workspace_id: options.workspaceId ?? options.target.workspace.id,
    actor_user_id: options.actorUserId === undefined ? options.target.leader.userId : options.actorUserId,
    entity_type: options.entityType ?? 'task',
    entity_id: options.entityId,
    action: options.action ?? 'update',
    changes_json: JSON.stringify(options.changes ?? { title: ['前', '後'] }),
    created_at: options.at,
  });
}

describe('recent-activity', () => {
  test('変更とコメントを新しい順に混ぜ、した人の今の名前、ワークスペース名、対象の題、内容の種類を返す', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const task = await createTask(organization, workspace.id, leaderId, { title: '見積もりを送る' });
    const story = await createStory(organization, workspace.id, leaderId, { title: '見積もりを整える' });
    const epic = await createEpic(organization, workspace.id, leaderId, { title: '会員ポイント制度を公開する' });
    await log({
      target,
      entityId: task.id,
      action: 'create',
      changes: { title: [null, '見積もりを送る'] },
      at: minutesLater(1),
    });
    await createComment(organization, workspace.id, task.id, target.member.userId!, {
      body_md: '確認しました。',
      created_at: minutesLater(2),
    });
    await log({
      target,
      entityType: 'story',
      entityId: story.id,
      changes: { title: ['前', '後'], due_on: [null, '2030-02-01'], body_md: [null, '長い本文'], mystery: [1, 2] },
      at: minutesLater(3),
    });
    await log({
      target,
      entityId: task.id,
      action: 'complete',
      changes: { completed_at: [null, minutesLater(4)] },
      at: minutesLater(4),
    });
    await log({ target, entityType: 'epic', entityId: epic.id, action: 'reopen', changes: {}, at: minutesLater(5) });
    await log({ target, entityId: task.id, action: 'restore', changes: {}, at: minutesLater(6), actorUserId: null });

    const result = await read(target, target.member);
    expect(result.next).toBeNull();
    expect(
      result.entries.map((entry) => [entry.created_at, entry.target.kind, entry.target.title, entry.event.kind]),
    ).toEqual([
      [minutesLater(6), 'task', '見積もりを送る', 'other'],
      [minutesLater(5), 'epic', '会員ポイント制度を公開する', 'reopen'],
      [minutesLater(4), 'task', '見積もりを送る', 'complete'],
      [minutesLater(3), 'story', '見積もりを整える', 'update'],
      [minutesLater(2), 'task', '見積もりを送る', 'comment'],
      [minutesLater(1), 'task', '見積もりを送る', 'create'],
    ]);
    const [restored, , , updated, comment, created] = result.entries;
    // 変えた欄の名前だけで、値は返さない
    expect(updated!.event).toEqual({ kind: 'update', fields: ['title', 'due_on', 'body_md', 'mystery'] });
    expect(JSON.stringify(result)).not.toContain('長い本文');
    expect(comment!.event).toEqual({ kind: 'comment', body: '確認しました。', truncated: false });
    expect(comment!.target).toEqual({ kind: 'task', id: task.id, title: '見積もりを送る' });
    expect(comment!.actor).toEqual({ id: target.member.userId, name: '星野 澪' });
    expect(created!.actor).toEqual({ id: leaderId, name: '星野 澪' });
    expect(created!.workspace).toEqual({ id: workspace.id, name: '青葉チーム' });
    // 定期処理か運用者の行は、した人が null
    expect(restored!.actor).toBeNull();
    expect(updated!.id).toEqual(expect.any(String));
  });

  test('した人の名前は今の名前で返す', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const writer = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    const db = orgDb(env, organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ name: '白川 葵' })
          .where('id', '=', writer.userId!)
          .where('organization_id', '=', organization.id),
      ),
    );
    const task = await createTask(organization, workspace.id, writer.userId!);
    await log({ target, entityId: task.id, actorUserId: writer.userId, at: minutesLater(1) });
    const result = await read(target, target.member);
    expect(result.entries[0]!.actor).toEqual({ id: writer.userId, name: '白川 葵' });
  });

  test('所属していないワークスペースは、管理者でも返さない。抜けたワークスペースと閉じたワークスペースも返さない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const adminId = target.admin.userId!;
    const task = await createTask(organization, target.workspace.id, adminId, { title: '自分のチームの作業' });
    const other = await createTask(organization, target.otherWorkspace.id, adminId, { title: '別のチームの作業' });
    await log({ target, entityId: task.id, at: minutesLater(1) });
    await log({ target, workspaceId: target.otherWorkspace.id, entityId: other.id, at: minutesLater(2) });
    await createComment(organization, target.otherWorkspace.id, other.id, adminId, { created_at: minutesLater(3) });

    // 管理者はどのワークスペースにも所属していない
    expect((await read(target, target.admin)).entries).toEqual([]);
    // メンバーは所属するワークスペースの分だけ。bystander は別のワークスペースの分だけ
    expect((await read(target, target.member)).entries.map((entry) => entry.target.title)).toEqual([
      '自分のチームの作業',
    ]);
    expect((await read(target, target.bystander)).entries.map((entry) => entry.target.title)).toEqual([
      '別のチームの作業',
      '別のチームの作業',
    ]);

    // 所属を抜けると出ない（抜けた後も入れる管理者で確かめる）
    const db = orgDb(env, organization.verified);
    const adminMember = await createPerson({
      organization,
      admin: true,
      membership: { workspaceId: target.otherWorkspace.id, role: 'member' },
    });
    expect((await read(target, adminMember)).entries).toHaveLength(2);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: minutesLater(10), left_on: '2030-01-01' })
          .where('user_id', '=', adminMember.userId!),
      ),
    );
    expect((await read(target, adminMember)).entries).toEqual([]);

    // 閉じたワークスペースは出ない
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: minutesLater(11) })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', organization.id),
      ),
    );
    expect((await read(target, target.member)).entries).toEqual([]);
  });

  test('複数のワークスペースに所属していれば、まとめて新しい順に並べる', async () => {
    const target = await createTarget();
    const { organization } = target;
    await createMembership(organization, target.otherWorkspace.id, target.member.userId!);
    const first = await createTask(organization, target.workspace.id, target.leader.userId!, { title: '青葉の作業' });
    const second = await createTask(organization, target.otherWorkspace.id, target.leader.userId!, {
      title: '別のチームの作業',
    });
    await log({ target, entityId: first.id, at: minutesLater(1) });
    await log({ target, workspaceId: target.otherWorkspace.id, entityId: second.id, at: minutesLater(2) });
    await log({ target, entityId: first.id, at: minutesLater(3) });
    const result = await read(target, target.member);
    expect(result.entries.map((entry) => [entry.workspace.id === target.workspace.id, entry.target.title])).toEqual([
      [true, '青葉の作業'],
      [false, '別のチームの作業'],
      [true, '青葉の作業'],
    ]);
  });

  test('別の組織の行は返さない。別の組織の人を指す行は、した人を null にする', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.leader.userId!, {
      title: '別の組織の作業',
    });
    await log({ target, entityId: task.id, actorUserId: foreign.leader.userId, at: minutesLater(1) });
    await log({ target: foreign, entityId: foreignTask.id, at: minutesLater(2) });
    await createComment(foreign.organization, foreign.workspace.id, foreignTask.id, foreign.leader.userId!, {
      created_at: minutesLater(3),
    });
    // 別の組織の ID を、この組織の行として書いた壊れた行（組織と一致しないので読まない）
    await createChangeLog(foreign.organization, {
      workspace_id: target.workspace.id,
      entity_type: 'task',
      entity_id: task.id,
      action: 'update',
      created_at: minutesLater(4),
    });

    const result = await read(target, target.member);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.actor).toBeNull();
    expect((await read(foreign, foreign.member)).entries.map((entry) => entry.target.title)).toEqual([
      '別の組織の作業',
      '別の組織の作業',
    ]);
  });

  test('リーダーと管理者だけが見られる履歴と、コメントの編集と削除の履歴、削除の履歴は返さない', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const task = await createTask(organization, workspace.id, leaderId);
    await log({ target, entityId: task.id, at: minutesLater(1) });
    await log({
      target,
      entityType: 'membership',
      entityId: target.member.userId!,
      action: 'update',
      changes: { role: ['member', 'leader'] },
      at: minutesLater(2),
    });
    await log({ target, entityType: 'allocation', entityId: uuidv7(), action: 'create', at: minutesLater(3) });
    await log({ target, entityType: 'connection', entityId: uuidv7(), action: 'update', at: minutesLater(4) });
    await log({ target, entityType: 'sprint', entityId: uuidv7(), action: 'update', at: minutesLater(5) });
    await log({ target, entityType: 'category', entityId: uuidv7(), action: 'create', at: minutesLater(6) });
    await log({
      target,
      entityType: 'comment',
      entityId: uuidv7(),
      action: 'delete',
      changes: { task_id: [task.id, task.id] },
      at: minutesLater(7),
    });
    await log({ target, entityType: 'workspace', entityId: workspace.id, action: 'update', at: minutesLater(8) });
    await log({
      target,
      entityId: task.id,
      action: 'delete',
      changes: { deleted_at: [null, minutesLater(9)] },
      at: minutesLater(9),
    });
    // ワークスペースの外の行（組織の変更）
    await createChangeLog(organization, {
      entity_type: 'organization',
      entity_id: organization.id,
      created_at: minutesLater(10),
    });

    const result = await read(target, target.leader);
    expect(result.entries.map((entry) => [entry.created_at, entry.event.kind])).toEqual([[minutesLater(1), 'update']]);
  });

  test('消したタスク、ストーリー、エピックの変更とコメントと、消したコメントは返さない', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const live = await createTask(organization, workspace.id, leaderId, { title: '残るタスク' });
    const gone = await createTask(organization, workspace.id, leaderId, {
      title: '消したタスク',
      deleted_at: minutesLater(20),
    });
    const goneStory = await createStory(organization, workspace.id, leaderId, {
      title: '消したストーリー',
      deleted_at: minutesLater(20),
    });
    const goneEpic = await createEpic(organization, workspace.id, leaderId, {
      title: '消したエピック',
      deleted_at: minutesLater(20),
    });
    await log({ target, entityId: live.id, at: minutesLater(1) });
    await log({ target, entityId: gone.id, at: minutesLater(2) });
    await log({ target, entityType: 'story', entityId: goneStory.id, at: minutesLater(3) });
    await log({ target, entityType: 'epic', entityId: goneEpic.id, at: minutesLater(4) });
    // 対象の行が無い（物理的に消えた、別のワークスペースの対象を指す）行
    await log({ target, entityId: uuidv7(), at: minutesLater(5) });
    await createComment(organization, workspace.id, live.id, leaderId, {
      body_md: '残るコメント',
      created_at: minutesLater(6),
    });
    await createComment(organization, workspace.id, live.id, leaderId, {
      body_md: '',
      deleted_at: minutesLater(7),
      deleted_by: leaderId,
      created_at: minutesLater(7),
    });
    await createComment(organization, workspace.id, gone.id, leaderId, {
      body_md: '消したタスクのコメント',
      created_at: minutesLater(8),
    });

    const result = await read(target, target.member);
    expect(result.entries.map((entry) => [entry.target.title, entry.event.kind])).toEqual([
      ['残るタスク', 'comment'],
      ['残るタスク', 'update'],
    ]);
    expect(JSON.stringify(result)).not.toContain('消した');
  });

  test('コメントの本文は先頭の 200 字（コードポイント）までを返し、切ったかを添える', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const task = await createTask(organization, workspace.id, target.leader.userId!);
    const exact = '😀'.repeat(RECENT_ACTIVITY_BODY_LENGTH);
    const long = `${'あ'.repeat(RECENT_ACTIVITY_BODY_LENGTH)}余り`;
    const huge = `# 見出し\n${'あ'.repeat(100_000 - 6)}`;
    await createComment(organization, workspace.id, task.id, target.leader.userId!, {
      body_md: exact,
      created_at: minutesLater(1),
    });
    await createComment(organization, workspace.id, task.id, target.leader.userId!, {
      body_md: long,
      created_at: minutesLater(2),
    });
    await createComment(organization, workspace.id, task.id, target.leader.userId!, {
      body_md: huge,
      created_at: minutesLater(3),
    });
    const [third, second, first] = (await read(target, target.member)).entries;
    expect(first!.event).toEqual({ kind: 'comment', body: exact, truncated: false });
    expect(second!.event).toEqual({ kind: 'comment', body: 'あ'.repeat(RECENT_ACTIVITY_BODY_LENGTH), truncated: true });
    expect(third!.event).toMatchObject({ kind: 'comment', truncated: true });
    // 切った本文は Markdown のまま（描かない）。長さは 200 字
    const body = (third!.event as { body: string }).body;
    expect(Array.from(body)).toHaveLength(RECENT_ACTIVITY_BODY_LENGTH);
    expect(body.startsWith('# 見出し\n')).toBe(true);
  });

  test('21 件以上は 20 件ずつ、続きのカーソルで重なりも抜けもなく読め、同じ created_at の行も境目で落ちない', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const task = await createTask(organization, workspace.id, leaderId);
    const expected: { id: string; created_at: string }[] = [];
    // 変更 30 件とコメント 25 件。ちょうど 20 件目と 21 件目をまたぐ 3 件と、ページの境目の 3 件が同じ created_at
    for (let i = 0; i < 30; i++) {
      const at = minutesLater(i < 6 ? 100 : 100 + i);
      expected.push(await log({ target, entityId: task.id, at }));
    }
    for (let i = 0; i < 25; i++) {
      const at = minutesLater(i < 6 ? 100 : 100 + i);
      expected.push(
        await createComment(organization, workspace.id, task.id, leaderId, { created_at: at, id: uuidv7() }),
      );
    }
    const order = [...expected].sort((a, b) =>
      a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : a.id < b.id ? 1 : -1,
    );

    const seen: string[] = [];
    let before: Cursor | undefined;
    const sizes: number[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await read(target, target.member, before);
      sizes.push(result.entries.length);
      seen.push(...result.entries.map((entry) => entry.id));
      if (result.next === null) break;
      expect(result.entries).toHaveLength(RECENT_ACTIVITY_PAGE_SIZE);
      const last = result.entries.at(-1)!;
      expect(result.next).toEqual({ created_at: last.created_at, id: last.id });
      before = result.next;
    }
    expect(sizes).toEqual([20, 20, 15]);
    expect(seen).toEqual(order.map((row) => row.id));
    expect(new Set(seen).size).toBe(55);
  });

  test('ちょうど 20 件なら続きは無く、21 件目があれば続きがある', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const task = await createTask(organization, workspace.id, target.leader.userId!);
    for (let i = 0; i < 20; i++) await log({ target, entityId: task.id, at: minutesLater(i) });
    expect((await read(target, target.member)).next).toBeNull();
    await log({ target, entityId: task.id, at: minutesLater(30) });
    const first = await read(target, target.member);
    expect(first.entries).toHaveLength(20);
    expect(first.next).not.toBeNull();
    const second = await read(target, target.member, first.next!);
    expect(second.entries).toHaveLength(1);
    expect(second.next).toBeNull();
  });

  test('カーソルは created_at が ISO 8601（ミリ秒まで）でなければ 400', async () => {
    const target = await createTarget();
    for (const before of [
      { created_at: 'あした', id: uuidv7() },
      { created_at: '2030-01-01', id: uuidv7() },
      { id: uuidv7() },
      'x',
    ]) {
      const res = await call(target, target.member, { before });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
  });

  test('ワークスペースごとの文は、索引で新しい順に読み、並べ替えを持たない', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    for (const before of [undefined, { created_at: minutesLater(0), id: uuidv7() }]) {
      const changes = (await queryPlanForTest(env, recentChangesStatement(db, target.workspace.id, before))).join('\n');
      expect(changes, changes).toMatch(/SEARCH cl USING INDEX change_logs_workspace \(workspace_id=\?/);
      const comments = (await queryPlanForTest(env, recentCommentsStatement(db, target.workspace.id, before))).join(
        '\n',
      );
      expect(comments, comments).toMatch(
        /SEARCH c USING (COVERING )?INDEX comments_workspace_created \(workspace_id=\?/,
      );
      expect(comments, comments).not.toMatch(/TEMP B-TREE/);
    }
  });
});
