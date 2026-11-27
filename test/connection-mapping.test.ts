// 接続の、取り込み元の状態から列への対応と期限を無視する設定（connection-mapping-save）と、それを使う場面
// （スプリントに入れたときの列、列の削除、同期の期限）。docs/requirements.md の「取り込み」
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { columnDelete } from '../src/shared/operations/column/index.ts';
import { connectionMappingSave } from '../src/shared/operations/connection/index.ts';
import { sprintTaskAdd } from '../src/shared/operations/sprint/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createBoardColumn,
  createConnection,
  createConnectionStatusMapping,
  createSprint,
  createTask,
  createTaskSource,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

async function setup() {
  const target = await createTarget();
  const done = await createBoardColumn(target.organization, target.workspace.id, {
    name: null,
    is_done: 1,
    position: 'Zz',
  });
  const review = await createBoardColumn(target.organization, target.workspace.id, { name: '確認', position: 'a1' });
  const first = await createBoardColumn(target.organization, target.workspace.id, { name: '出発前', position: 'a0' });
  const connection = await createConnection(target.organization, target.workspace.id, target.member.userId!);
  return { target, done: done.id, review: review.id, first: first.id, connection };
}

function save(
  target: Target,
  connectionId: string,
  body: { mappings: { source_status: string; column_id: string }[]; ignore_source_due: boolean },
  caller: Person = target.member,
  workspaceId = target.workspace.id,
) {
  return post(app, connectionMappingSave, {
    slug: target.slug,
    token: caller.token,
    body: { workspace_id: workspaceId, connection_id: connectionId, ...body },
  });
}

async function importedTask(target: Target, connectionId: string, status: string, due: string | null = null) {
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, { is_imported: 1 });
  await createTaskSource(target.organization, target.workspace.id, task.id, connectionId, {
    source_status: status,
    source_due_on: due,
  });
  return task;
}

async function taskRow(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(db.statement((q) => q.selectFrom('tasks').select(['column_id', 'sprint_id']).where('id', '=', id)));
}

describe('connection-mapping-save', () => {
  test('対応と期限を無視する設定を置き換え、取り込み済みの期限を空にする。履歴は件数と設定だけ', async () => {
    const { target, review, connection } = await setup();
    const task = await importedTask(target, connection.id, 'open', '2026-12-01');

    const res = await save(target, connection.id, {
      mappings: [{ source_status: 'open', column_id: review }],
      ignore_source_due: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connection: {
        id: connection.id,
        ignore_source_due: true,
        status_mappings: [{ source_status: 'open', column_id: review }],
        source_statuses: ['open'],
      },
    });
    const db = orgDb(env, target.organization.verified);
    const source = await db.first(
      db.statement((q) => q.selectFrom('task_sources').select('source_due_on').where('task_id', '=', task.id)),
    );
    expect(source?.source_due_on).toBeNull();
    const logs = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('changes_json')
          .where('entity_type', '=', 'connection')
          .where('entity_id', '=', connection.id),
      ),
    );
    expect(logs.map((log) => JSON.parse(log.changes_json))).toEqual([
      { status_mappings_count: [0, 1], ignore_source_due: [0, 1] },
    ]);

    // 置き換える（前の対応は残らない）
    const again = await save(target, connection.id, { mappings: [], ignore_source_due: false });
    expect(await again.json()).toMatchObject({ connection: { ignore_source_due: false, status_mappings: [] } });
  });

  test('期限の無視をやめると、次の同期が全部を読むよう最後の成功を空にする', async () => {
    const { target, connection } = await setup();
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('connections')
          .set({ ignore_source_due: 1, last_success_at: '2026-11-01T00:00:00.000Z' })
          .where('id', '=', connection.id),
      ),
    );
    expect((await save(target, connection.id, { mappings: [], ignore_source_due: true })).status).toBe(200);
    const kept = await db.first(
      db.statement((q) => q.selectFrom('connections').select('last_success_at').where('id', '=', connection.id)),
    );
    expect(kept?.last_success_at).toBe('2026-11-01T00:00:00.000Z');
    expect((await save(target, connection.id, { mappings: [], ignore_source_due: false })).status).toBe(200);
    const reset = await db.first(
      db.statement((q) => q.selectFrom('connections').select('last_success_at').where('id', '=', connection.id)),
    );
    expect(reset?.last_success_at).toBeNull();
  });

  test('完了の列と、ワークスペースに無い列は 400 で、何も書かない', async () => {
    const { target, done, connection } = await setup();
    const doneRes = await save(target, connection.id, {
      mappings: [{ source_status: 'open', column_id: done }],
      ignore_source_due: true,
    });
    expect(doneRes.status).toBe(400);
    expect(JSON.stringify(await doneRes.json())).toContain('column_done');
    const missing = await save(target, connection.id, {
      mappings: [{ source_status: 'open', column_id: '019a0000-0000-7000-8000-00000000dead' }],
      ignore_source_due: true,
    });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain('column_unknown');
    const db = orgDb(env, target.organization.verified);
    const row = await db.first(
      db.statement((q) => q.selectFrom('connections').select('ignore_source_due').where('id', '=', connection.id)),
    );
    expect(Number(row?.ignore_source_due)).toBe(0);
  });

  test('他の人の接続は 403、別のワークスペースの列は 400', async () => {
    const { target, review, connection } = await setup();
    const other = await save(target, connection.id, { mappings: [], ignore_source_due: true }, target.leader);
    expect(other.status).toBe(403);
    const otherTarget = await setup();
    const foreign = await save(target, connection.id, {
      mappings: [{ source_status: 'open', column_id: otherTarget.review }],
      ignore_source_due: false,
    });
    expect(foreign.status).toBe(400);
  });
});

describe('スプリントに入れるときの列', () => {
  test('対応のある状態はその列へ、対応の無い状態は先頭の列へ置き、列ごとにスプリントの末尾へ並べる', async () => {
    const { target, review, first, connection } = await setup();
    await createConnectionStatusMapping(target.organization, connection.id, review, { source_status: 'open' });
    const mapped = await importedTask(target, connection.id, 'open');
    const unmapped = await importedTask(target, connection.id, 'draft');
    const manual = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const sprint = await createSprint(target.organization, target.workspace.id, { name: '第15回' });

    const res = await post(app, sprintTaskAdd, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, sprint_id: sprint.id, task_ids: [mapped.id, unmapped.id, manual.id] },
    });
    expect(res.status).toBe(200);
    expect(await taskRow(target, mapped.id)).toMatchObject({ column_id: review, sprint_id: sprint.id });
    expect(await taskRow(target, unmapped.id)).toMatchObject({ column_id: first });
    expect(await taskRow(target, manual.id)).toMatchObject({ column_id: first });
  });
});

describe('スプリントに入れるときの列（境界）', () => {
  async function addTo(target: Target, sprintId: string, ids: string[]) {
    return post(app, sprintTaskAdd, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, sprint_id: sprintId, task_ids: ids },
    });
  }
  async function positionOf(target: Target, id: string) {
    const db = orgDb(env, target.organization.verified);
    return db.first(
      db.statement((q) => q.selectFrom('tasks').select(['column_id', 'column_position']).where('id', '=', id)),
    );
  }

  test('対応先の列に既にあるカードの後ろへ、送った順に並ぶ', async () => {
    const { target, review, first, connection } = await setup();
    await createConnectionStatusMapping(target.organization, connection.id, review, { source_status: 'open' });
    const sprint = await createSprint(target.organization, target.workspace.id, { name: '第15回' });
    await createTask(target.organization, target.workspace.id, target.member.userId!, {
      sprint_id: sprint.id,
      column_id: review,
      column_position: 'a5',
    });
    const one = await importedTask(target, connection.id, 'open');
    const two = await importedTask(target, connection.id, 'open');
    const manual = await createTask(target.organization, target.workspace.id, target.member.userId!);
    expect((await addTo(target, sprint.id, [one.id, two.id, manual.id])).status).toBe(200);
    const [a, b, c] = await Promise.all([one, two, manual].map((task) => positionOf(target, task.id)));
    expect(a).toMatchObject({ column_id: review });
    expect(b).toMatchObject({ column_id: review });
    expect(a!.column_position! > 'a5').toBe(true);
    expect(b!.column_position! > a!.column_position!).toBe(true);
    expect(c).toMatchObject({ column_id: first, column_position: 'a0' });
  });

  test('完了の列と、削除した列を指す対応は無視して先頭の列へ置く', async () => {
    const { target, review, done, first, connection } = await setup();
    await createConnectionStatusMapping(target.organization, connection.id, done, { source_status: 'closed' });
    await createConnectionStatusMapping(target.organization, connection.id, review, { source_status: 'open' });
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q.updateTable('board_columns').set({ deleted_at: '2026-11-02T00:00:00.000Z' }).where('id', '=', review),
      ),
    );
    const sprint = await createSprint(target.organization, target.workspace.id, { name: '第15回' });
    const closed = await importedTask(target, connection.id, 'closed');
    const open = await importedTask(target, connection.id, 'open');
    expect((await addTo(target, sprint.id, [closed.id, open.id])).status).toBe(200);
    expect(await positionOf(target, closed.id)).toMatchObject({ column_id: first });
    expect(await positionOf(target, open.id)).toMatchObject({ column_id: first });
  });

  test('削除した接続のタスクは、対応があっても先頭の列に置く', async () => {
    const { target, review, first, connection } = await setup();
    await createConnectionStatusMapping(target.organization, connection.id, review, { source_status: 'open' });
    const task = await importedTask(target, connection.id, 'open');
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q.updateTable('connections').set({ deleted_at: '2026-11-02T00:00:00.000Z' }).where('id', '=', connection.id),
      ),
    );
    const sprint = await createSprint(target.organization, target.workspace.id, { name: '第15回' });
    expect((await addTo(target, sprint.id, [task.id])).status).toBe(200);
    expect(await positionOf(target, task.id)).toMatchObject({ column_id: first });
  });
});

describe('列の削除', () => {
  test('列を削除すると、その列への対応が外れる', async () => {
    const { target, review, first, connection } = await setup();
    await createConnectionStatusMapping(target.organization, connection.id, review, { source_status: 'open' });
    const res = await post(app, columnDelete, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, column_id: review, target_column_id: first },
    });
    expect(res.status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) =>
        q.selectFrom('connection_status_mappings').selectAll().where('connection_id', '=', connection.id),
      ),
    );
    expect(rows).toEqual([]);
  });

  test('タスクが残る列を削除すると、移した件数が返り、その列への対応だけが外れる。ほかの対応は残る', async () => {
    const { target, review, first, connection } = await setup();
    const other = await createBoardColumn(target.organization, target.workspace.id, { name: '作業中', position: 'a2' });
    await createConnectionStatusMapping(target.organization, connection.id, review, { source_status: 'open' });
    await createConnectionStatusMapping(target.organization, connection.id, other.id, { source_status: 'draft' });
    const sprint = await createSprint(target.organization, target.workspace.id, { name: '第15回' });
    for (const position of ['a0', 'a1']) {
      await createTask(target.organization, target.workspace.id, target.member.userId!, {
        sprint_id: sprint.id,
        column_id: review,
        column_position: position,
      });
    }
    const res = await post(app, columnDelete, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, column_id: review, target_column_id: first },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ moved_count: 2 });
    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) =>
        q.selectFrom('connection_status_mappings').select('source_status').where('connection_id', '=', connection.id),
      ),
    );
    expect(rows).toEqual([{ source_status: 'draft' }]);
  });
});

describe('connection-mapping-save の範囲外', () => {
  test('別のワークスペースと削除済みの接続は 404', async () => {
    const { target, connection } = await setup();
    const elsewhere = await setup();
    const foreign = await save(target, elsewhere.connection.id, { mappings: [], ignore_source_due: true });
    expect(foreign.status).toBe(404);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q.updateTable('connections').set({ deleted_at: '2026-11-02T00:00:00.000Z' }).where('id', '=', connection.id),
      ),
    );
    const deleted = await save(target, connection.id, { mappings: [], ignore_source_due: true });
    expect(deleted.status).toBe(404);
  });
});

describe('connection-mapping-save の追加の確かめ', () => {
  test('持ち主が去って止めた接続の保存は 409 の connection_stopped', async () => {
    const { target, connection } = await setup();
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('connections')
          .set({ status: 'stopped', stopped_reason: 'member_left' })
          .where('id', '=', connection.id),
      ),
    );
    const res = await save(target, connection.id, { mappings: [], ignore_source_due: true });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('connection_stopped');
  });

  test('保存できない状態名（上限超え）は、選べる状態の一覧に出さない', async () => {
    const { target, connection } = await setup();
    await importedTask(target, connection.id, 'x'.repeat(101));
    await importedTask(target, connection.id, 'open');
    const res = await save(target, connection.id, { mappings: [], ignore_source_due: false });
    expect(((await res.json()) as { connection: { source_statuses: string[] } }).connection.source_statuses).toEqual([
      'open',
    ]);
  });
});
