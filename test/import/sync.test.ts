// 取り込み元に依らない同期の仕組み（src/server/import/sync.ts）。GitHub ではない偽の取り込み元を差し、
// 同期の関数を直に呼ぶ。取り込み元の通信は fetcher に偽物を差さず、ImportSource の実装そのものを偽にする
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../../src/server/db/index.ts';
import { encryptCredential } from '../../src/server/crypto/credential.ts';
import { syncConnection } from '../../src/server/import/sync.ts';
import {
  ImportSourceError,
  type FetchPageInput,
  type ImportItem,
  type ImportSource,
  type ImportSourceFailure,
} from '../../src/server/import/source.ts';
import {
  createConnection,
  createConnectionScope,
  createMembership,
  createOrganization,
  createRepository,
  createUser,
  createWorkspace,
  uuidv7,
} from '../factories.ts';

const SECRET = 'fake-secret-ZZZ-0001';

function item(n: number, overrides: Partial<ImportItem> = {}): ImportItem {
  return {
    kind: 'issue',
    sourceId: `src-${n}`,
    reviewerSourceId: '',
    key: `fake/box#${n}`,
    url: `https://fake.example/box/${n}`,
    title: `項目 ${n}`,
    containerId: '501',
    containerName: 'fake/box',
    status: 'open',
    dueOn: null,
    updatedAt: '2026-11-01T00:00:00.000Z',
    isDone: false,
    ...overrides,
  };
}

type Page = { items: ImportItem[]; next: string | null };

// 範囲 ID ごとの頁の並びを返す偽の取り込み元。cursor は頁の番号の文字列
function fakeSource(pages: Record<string, Page[]>, hooks: { fail?: ImportSourceFailure; candidates?: string[] } = {}) {
  const calls: FetchPageInput[] = [];
  const source: ImportSource = {
    kind: 'github',
    scopeKind: 'github_repo',
    parseSettings: () => ({}),
    isCredentialShape: () => true,
    credentialLast4: (credential) => credential.slice(-4),
    verifyCredential: async () => ({ kind: 'user', id: '1', name: 'fake' }),
    listScopeCandidates: async () =>
      (hooks.candidates ?? Object.keys(pages)).map((id) => ({ id, name: `scope-${id}` })),
    async fetchPage(input) {
      calls.push(input);
      if (hooks.fail !== undefined) {
        throw new ImportSourceError(hooks.fail, `${SECRET} https://leak.example/${SECRET}`);
      }
      const index = input.cursor === null ? 0 : Number(input.cursor);
      const page = pages[input.scope.id]?.[index];
      if (page === undefined) return { items: [], next: null };
      return { items: page.items, next: page.next };
    },
  };
  return { source, calls };
}

async function setup() {
  const organization = await createOrganization();
  const owner = await createUser(organization, { name: '星野 澪' });
  const workspace = await createWorkspace(organization, owner.id);
  await createMembership(organization, workspace.id, owner.id);
  const connectionId = uuidv7();
  const real = await encryptCredential(env, SECRET, connectionId);
  const connection = await createConnection(organization, workspace.id, owner.id, {
    id: connectionId,
    credential_ciphertext: real.ciphertext,
    credential_key_version: real.keyVersion,
    credential_last4: SECRET.slice(-4),
  });
  await createConnectionScope(organization, connection.id, { source_id: '501', source_name: 'fake/box' });
  return { organization, owner, workspace, connection, db: orgDb(env, organization.verified) };
}

async function tasksOf(db: ReturnType<typeof orgDb>, workspaceId: string) {
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select(['id', 'title', 'tray', 'is_imported', 'assignee_user_id', 'repository_id', 'position', 'created_by'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('position')
        .orderBy('id'),
    ),
  );
}

async function sourcesOf(db: ReturnType<typeof orgDb>, workspaceId: string) {
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('task_sources')
        .select(['task_id', 'source_id', 'source_key', 'connection_id', 'is_source_done'])
        .where('workspace_id', '=', workspaceId),
    ),
  );
}

async function connectionOf(db: ReturnType<typeof orgDb>, id: string) {
  const row = await db.first(db.statement((q) => q.selectFrom('connections').selectAll().where('id', '=', id)));
  return row!;
}

describe('取り込みの同期', () => {
  test('未完了の項目が受信箱のタスクとして入り、担当は接続の登録者になる', async () => {
    const { owner, workspace, connection, db } = await setup();
    const { source } = fakeSource({ '501': [{ items: [item(1), item(2, { isDone: true }), item(3)], next: null }] });
    const result = await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(result).toEqual({ outcome: 'success', imported: 2, more: false });

    const tasks = await tasksOf(db, workspace.id);
    expect(tasks.map((t) => t.title)).toEqual(['項目 1', '項目 3']);
    for (const task of tasks) {
      expect(task).toMatchObject({ tray: 'inbox', is_imported: 1, assignee_user_id: owner.id, created_by: null });
    }
    const sources = await sourcesOf(db, workspace.id);
    expect(sources.map((s) => s.source_id).sort()).toEqual(['src-1', 'src-3']);
    expect(sources.every((s) => s.connection_id === connection.id && s.is_source_done === 0)).toBe(true);
    expect(new Set(sources.map((s) => s.task_id))).toEqual(new Set(tasks.map((t) => t.id)));

    const after = await connectionOf(db, connection.id);
    expect(after).toMatchObject({ status: 'active', consecutive_failures: 0, last_error_message: null });
    expect(after.last_success_at).not.toBeNull();
    expect(after.sync_state_json).toBe('{}');
  });

  test('受信箱の末尾に並べ、結んだリポジトリがあれば repository_id も書く', async () => {
    const { organization, workspace, connection, db } = await setup();
    const repo = await createRepository(organization, workspace.id, {
      provider: 'github',
      source_container_id: '501',
      source_container_name: 'fake/box',
    });
    const { source } = fakeSource({
      '501': [{ items: [item(1), item(2, { containerId: '999', containerName: 'fake/other' })], next: null }],
    });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    const first = await tasksOf(db, workspace.id);
    expect(first.map((t) => t.repository_id)).toEqual([repo.id, null]);

    const { source: more } = fakeSource({ '501': [{ items: [item(4)], next: null }] });
    await syncConnection(env, db, workspace.id, connection.id, { source: more });
    const all = await tasksOf(db, workspace.id);
    expect(all.map((t) => t.title)).toEqual(['項目 1', '項目 2', '項目 4']);
  });

  test('タイトルは見えない文字を除き、200字で切る。何も残らなければキーを使う', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({
      '501': [
        {
          items: [
            item(1, { title: ' 修正​ する\n続き‮ ' }),
            item(2, { title: 'あ'.repeat(300) }),
            item(3, { title: '\u{200B}\u{200B}' }),
          ],
          next: null,
        },
      ],
    });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    const titles = (await tasksOf(db, workspace.id)).map((t) => t.title);
    expect(titles).toContain('修正 する 続き');
    expect(titles).toContain('あ'.repeat(200));
    expect(titles).toContain('fake/box#3');
  });

  test('2回同期しても二重に入らない', async () => {
    const { workspace, connection, db } = await setup();
    const pages = { '501': [{ items: [item(1), item(2)], next: null }] };
    const { source } = fakeSource(pages);
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toMatchObject({ imported: 2 });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toMatchObject({ imported: 0 });
    expect(await tasksOf(db, workspace.id)).toHaveLength(2);
    expect(await sourcesOf(db, workspace.id)).toHaveLength(2);
  });

  describe('取り込み済みの項目の更新', () => {
    async function firstTask(db: ReturnType<typeof orgDb>, workspaceId: string) {
      return (await db.first(
        db.statement((q) =>
          q
            .selectFrom('tasks')
            .innerJoin('task_sources', 'task_sources.task_id', 'tasks.id')
            .selectAll('tasks')
            .select([
              'task_sources.source_url',
              'task_sources.source_status',
              'task_sources.source_due_on',
              'task_sources.is_source_done',
              'task_sources.source_updated_at',
            ])
            .where('tasks.workspace_id', '=', workspaceId),
        ),
      ))!;
    }
    async function logCount(db: ReturnType<typeof orgDb>, workspaceId: string) {
      const rows = await db.rows(
        db.statement((q) => q.selectFrom('change_logs').select('id').where('workspace_id', '=', workspaceId)),
      );
      return rows.length;
    }

    test('取り込み元が持つ属性だけが映り、Banmen が持つ属性とタスクの完了は変わらず、履歴も書かない', async () => {
      const { organization, workspace, connection, db } = await setup();
      const other = await createUser(organization, { name: '緑川 凪' });
      await createMembership(organization, workspace.id, other.id);
      const first = fakeSource({ '501': [{ items: [item(1)], next: null }] });
      await syncConnection(env, db, workspace.id, connection.id, { source: first.source });
      const before = await firstTask(db, workspace.id);
      // 人が付けた属性
      await db.run(
        db.statement((q) =>
          q
            .updateTable('tasks')
            .set({ tray: 'backlog', points: 5, due_on: '2026-12-24', assignee_user_id: other.id })
            .where('id', '=', before.id),
        ),
      );
      const changed = item(1, {
        title: '  新しい題\n2行目 ',
        url: 'https://fake.example/box/1-moved',
        status: 'in review',
        dueOn: '2026-12-10',
        updatedAt: '2026-11-02T00:00:00.000Z',
      });
      const second = fakeSource({ '501': [{ items: [changed], next: null }] });
      expect(await syncConnection(env, db, workspace.id, connection.id, { source: second.source })).toMatchObject({
        outcome: 'success',
        imported: 0,
      });
      const after = await firstTask(db, workspace.id);
      expect(after).toMatchObject({
        id: before.id,
        title: '新しい題 2行目',
        source_url: 'https://fake.example/box/1-moved',
        source_status: 'in review',
        source_due_on: '2026-12-10',
        source_updated_at: '2026-11-02T00:00:00.000Z',
        is_source_done: 0,
        // Banmen が持つ属性
        tray: 'backlog',
        points: 5,
        due_on: '2026-12-24',
        assignee_user_id: other.id,
        repository_id: before.repository_id,
        sprint_id: before.sprint_id,
        column_id: before.column_id,
        story_id: before.story_id,
        completed_at: null,
      });
      expect(await tasksOf(db, workspace.id)).toHaveLength(1);
      expect(await logCount(db, workspace.id)).toBe(0);
    });

    test('期限を無視する接続は、新しい項目も更新でも取り込み元の期限を書かない', async () => {
      const { workspace, connection, db } = await setup();
      await db.run(
        db.statement((q) => q.updateTable('connections').set({ ignore_source_due: 1 }).where('id', '=', connection.id)),
      );
      const run = (over: Partial<ImportItem>) =>
        syncConnection(env, db, workspace.id, connection.id, {
          source: fakeSource({ '501': [{ items: [item(1, over)], next: null }] }).source,
        });
      await run({ dueOn: '2026-12-10' });
      expect((await firstTask(db, workspace.id)).source_due_on).toBeNull();
      await run({ dueOn: '2026-12-11', status: 'in review', updatedAt: '2026-11-02T00:00:00.000Z' });
      expect(await firstTask(db, workspace.id)).toMatchObject({ source_status: 'in review', source_due_on: null });
    });

    describe('同期の途中で期限の無視を変える', () => {
      // 2頁目を取る直前に、本人の保存（connection-mapping-save）と同じ書き込みを差し込む偽の取り込み元
      function racing(pages: Page[], beforeSecondPage: () => Promise<void>) {
        const fake = fakeSource({ '501': pages });
        const fetchPage = fake.source.fetchPage.bind(fake.source);
        fake.source.fetchPage = async (input) => {
          if (input.cursor === '1') await beforeSecondPage();
          return fetchPage(input);
        };
        return fake.source;
      }
      async function dues(db: ReturnType<typeof orgDb>, workspaceId: string) {
        const rows = await sourcesOfDue(db, workspaceId);
        return Object.fromEntries(rows.map((r) => [r.source_id, r.source_due_on]));
      }
      async function sourcesOfDue(db: ReturnType<typeof orgDb>, workspaceId: string) {
        return db.rows(
          db.statement((q) =>
            q.selectFrom('task_sources').select(['source_id', 'source_due_on']).where('workspace_id', '=', workspaceId),
          ),
        );
      }

      test('有効にした回の残りの頁は、保存が空にした期限を書き戻さず、次の同期が全部を読む', async () => {
        const { workspace, connection, db } = await setup();
        const source = racing(
          [
            { items: [item(1, { dueOn: '2026-12-10' })], next: '1' },
            {
              items: [
                item(1, { dueOn: '2026-12-11', status: 'in review', updatedAt: '2026-11-02T00:00:00.000Z' }),
                item(2, { dueOn: '2026-12-12' }),
              ],
              next: null,
            },
          ],
          async () => {
            await db.batch([
              db.statement((q) =>
                q.updateTable('connections').set({ ignore_source_due: 1 }).where('id', '=', connection.id),
              ),
              db.statement((q) =>
                q.updateTable('task_sources').set({ source_due_on: null }).where('connection_id', '=', connection.id),
              ),
            ]);
          },
        );
        await syncConnection(env, db, workspace.id, connection.id, { source });
        expect(await dues(db, workspace.id)).toEqual({ 'src-1': null, 'src-2': null });
        expect((await sourcesOf(db, workspace.id)).length).toBe(2);
        // 状態の更新は書かれている（期限だけを書かない）
        expect(
          (
            await db.first(
              db.statement((q) =>
                q
                  .selectFrom('task_sources')
                  .select('source_status')
                  .where('workspace_id', '=', workspace.id)
                  .where('source_id', '=', 'src-1'),
              ),
            )
          )?.source_status,
        ).toBe('in review');
        // 読んだ値と今の値が違うので、次の同期が全部を読む
        expect((await connectionOf(db, connection.id)).last_success_at).toBeNull();
      });

      test('同じ項目を別の接続が拾っても、期限は行の持ち主の接続の設定で決まる', async () => {
        const { organization, owner, workspace, connection, db } = await setup();
        const other = await createConnection(organization, workspace.id, owner.id, { ignore_source_due: 0 });
        await createConnectionScope(organization, other.id, { source_id: '501', source_name: 'fake/box' });
        const run = (id: string, over: Partial<ImportItem>) =>
          syncConnection(env, db, workspace.id, id, {
            source: fakeSource({ '501': [{ items: [item(1, over)], next: null }] }).source,
          });
        await db.run(
          db.statement((q) =>
            q.updateTable('connections').set({ ignore_source_due: 1 }).where('id', '=', connection.id),
          ),
        );
        await run(connection.id, { dueOn: '2026-12-10' });
        // 持ち主でない接続（無視をしていない）が同じ項目を、期限だけ違えて流しても、持ち主の設定で空のまま
        await run(other.id, { dueOn: '2026-12-11' });
        expect(await dues(db, workspace.id)).toEqual({ 'src-1': null });
      });

      test('外した回の残りの頁は期限を空で書くが、次の同期が全部を読んで期限が戻る', async () => {
        const { workspace, connection, db } = await setup();
        await db.run(
          db.statement((q) =>
            q.updateTable('connections').set({ ignore_source_due: 1 }).where('id', '=', connection.id),
          ),
        );
        const pages: Page[] = [
          { items: [item(1, { dueOn: '2026-12-10' })], next: '1' },
          { items: [item(2, { dueOn: '2026-12-12' })], next: null },
        ];
        const source = racing(pages, async () => {
          await db.run(
            db.statement((q) =>
              q
                .updateTable('connections')
                .set({ ignore_source_due: 0, last_success_at: null, sync_state_json: '{}' })
                .where('id', '=', connection.id),
            ),
          );
        });
        await syncConnection(env, db, workspace.id, connection.id, { source });
        // 2頁目は読んだ値（無視）のまま空で書かれる
        expect(await dues(db, workspace.id)).toEqual({ 'src-1': null, 'src-2': null });
        const done = await connectionOf(db, connection.id);
        expect(done.last_success_at).toBeNull();
        expect(done.sync_state_json).toBe('{}');
        await syncConnection(env, db, workspace.id, connection.id, { source: fakeSource({ '501': pages }).source });
        expect(await dues(db, workspace.id)).toEqual({ 'src-1': '2026-12-10', 'src-2': '2026-12-12' });
      });
    });

    test('取り込み元で閉じると完了の印が付き、タスクは完了にならない。開き直すと印が外れる', async () => {
      const { workspace, connection, db } = await setup();
      const run = async (over: Partial<ImportItem>) =>
        syncConnection(env, db, workspace.id, connection.id, {
          source: fakeSource({ '501': [{ items: [item(1, over)], next: null }] }).source,
        });
      await run({});
      await run({ isDone: true, status: 'closed', updatedAt: '2026-11-02T00:00:00.000Z' });
      let row = await firstTask(db, workspace.id);
      expect(row).toMatchObject({ is_source_done: 1, source_status: 'closed', completed_at: null, tray: 'inbox' });
      expect(await tasksOf(db, workspace.id)).toHaveLength(1);
      await run({ isDone: false, status: 'open', updatedAt: '2026-11-03T00:00:00.000Z' });
      row = await firstTask(db, workspace.id);
      expect(row).toMatchObject({ is_source_done: 0, source_status: 'open', completed_at: null });
      expect(await logCount(db, workspace.id)).toBe(0);
    });

    test('取り込んでいない完了済みの項目は入れない', async () => {
      const { workspace, connection, db } = await setup();
      await syncConnection(env, db, workspace.id, connection.id, {
        source: fakeSource({ '501': [{ items: [item(1), item(2, { isDone: true })], next: null }] }).source,
      });
      expect(await tasksOf(db, workspace.id)).toHaveLength(1);
    });

    test('古い更新日時の頁は新しい値を戻さず、同じ更新日時の頁は受ける', async () => {
      const { workspace, connection, db } = await setup();
      const run = (over: Partial<ImportItem>) =>
        syncConnection(env, db, workspace.id, connection.id, {
          source: fakeSource({ '501': [{ items: [item(1, over)], next: null }] }).source,
        });
      await run({});
      await run({ title: '新しい', updatedAt: '2026-11-05T00:00:00.000Z' });
      await run({ title: '古い', updatedAt: '2026-11-03T00:00:00.000Z' });
      expect(await firstTask(db, workspace.id)).toMatchObject({
        title: '新しい',
        source_updated_at: '2026-11-05T00:00:00.000Z',
      });
      await run({ title: '同じ時刻', updatedAt: '2026-11-05T00:00:00.000Z' });
      expect(await firstTask(db, workspace.id)).toMatchObject({ title: '同じ時刻' });
    });

    test('人が完了したタスクは、取り込み元で閉じても開き直しても完了のまま', async () => {
      const { owner, workspace, connection, db } = await setup();
      const run = (over: Partial<ImportItem>) =>
        syncConnection(env, db, workspace.id, connection.id, {
          source: fakeSource({ '501': [{ items: [item(1, over)], next: null }] }).source,
        });
      await run({});
      const id = (await firstTask(db, workspace.id)).id;
      await db.run(
        db.statement((q) =>
          q
            .updateTable('tasks')
            .set({ completed_at: '2026-11-01T01:00:00.000Z', completed_by: owner.id })
            .where('id', '=', id),
        ),
      );
      await run({ isDone: true, updatedAt: '2026-11-02T00:00:00.000Z' });
      expect(await firstTask(db, workspace.id)).toMatchObject({ is_source_done: 1, completed_by: owner.id });
      await run({ isDone: false, updatedAt: '2026-11-03T00:00:00.000Z' });
      expect(await firstTask(db, workspace.id)).toMatchObject({
        completed_at: '2026-11-01T01:00:00.000Z',
        completed_by: owner.id,
        is_source_done: 0,
      });
    });

    test('同期の最中に止まった接続は、取り込み済みの項目も更新しない', async () => {
      const { workspace, connection, db } = await setup();
      await syncConnection(env, db, workspace.id, connection.id, {
        source: fakeSource({ '501': [{ items: [item(1)], next: null }] }).source,
      });
      const stopMidway: ImportSource = {
        ...fakeSource({}).source,
        async fetchPage() {
          await db.run(
            db.statement((q) =>
              q
                .updateTable('connections')
                .set({ status: 'stopped', stopped_reason: 'leader' })
                .where('id', '=', connection.id),
            ),
          );
          return { items: [item(1, { title: '止まった後', updatedAt: '2026-11-09T00:00:00.000Z' })], next: null };
        },
      };
      await syncConnection(env, db, workspace.id, connection.id, { source: stopMidway });
      expect(await firstTask(db, workspace.id)).toMatchObject({
        title: '項目 1',
        source_updated_at: '2026-11-01T00:00:00.000Z',
      });
    });

    test('期限を取り込み元で外すと映り、新しい項目と混ざった頁でも入れた数は新しい項目だけを数える', async () => {
      const { workspace, connection, db } = await setup();
      const run = (items: ImportItem[]) =>
        syncConnection(env, db, workspace.id, connection.id, {
          source: fakeSource({ '501': [{ items, next: null }] }).source,
        });
      await run([item(1, { dueOn: '2026-12-10' })]);
      expect(await firstTask(db, workspace.id)).toMatchObject({ source_due_on: '2026-12-10' });
      const result = await run([
        item(1, { dueOn: null, title: '改名', updatedAt: '2026-11-02T00:00:00.000Z' }),
        item(2),
      ]);
      expect(result).toMatchObject({ imported: 1 });
      expect(await tasksOf(db, workspace.id)).toHaveLength(2);
      expect((await sourcesOf(db, workspace.id)).length).toBe(2);
      const row = await db.first(
        db.statement((q) => q.selectFrom('task_sources').select('source_due_on').where('source_id', '=', 'src-1')),
      );
      expect(row).toEqual({ source_due_on: null });
    });

    describe('変わらない項目は書かない', () => {
      async function stamps(db: ReturnType<typeof orgDb>, workspaceId: string) {
        return (await db.first(
          db.statement((q) =>
            q
              .selectFrom('task_sources')
              .innerJoin('tasks', 'tasks.id', 'task_sources.task_id')
              .select([
                'task_sources.last_seen_at as seen',
                'task_sources.updated_at as sourceUpdated',
                'tasks.updated_at as taskUpdated',
                'task_sources.source_url',
                'task_sources.source_status',
                'task_sources.source_due_on',
                'task_sources.is_source_done',
              ])
              .where('task_sources.workspace_id', '=', workspaceId),
          ),
        ))!;
      }

      test('同じ頁を日時を進めて2回流しても、書いた日時は1回目のまま', async () => {
        const { workspace, connection, db } = await setup();
        const run = (at: string) =>
          syncConnection(env, db, workspace.id, connection.id, {
            source: fakeSource({ '501': [{ items: [item(1)], next: null }] }).source,
            now: () => new Date(at),
          });
        await run('2026-11-10T00:00:00.000Z');
        const first = await stamps(db, workspace.id);
        await run('2026-11-11T00:00:00.000Z');
        expect(await stamps(db, workspace.id)).toEqual(first);
      });

      test.each([
        ['URL', { url: 'https://fake.example/box/1-new' }, { source_url: 'https://fake.example/box/1-new' }],
        ['状態', { status: 'in review' }, { source_status: 'in review' }],
        ['期限を付ける', { dueOn: '2026-12-10' }, { source_due_on: '2026-12-10' }],
        ['完了の印', { isDone: true }, { is_source_done: 1 }],
      ])('更新日時が同じでも、%s が変われば映る', async (_name, over, expected) => {
        const { workspace, connection, db } = await setup();
        const run = (o: Partial<ImportItem>, at: string) =>
          syncConnection(env, db, workspace.id, connection.id, {
            source: fakeSource({ '501': [{ items: [item(1, o)], next: null }] }).source,
            now: () => new Date(at),
          });
        await run({}, '2026-11-10T00:00:00.000Z');
        await run(over, '2026-11-11T00:00:00.000Z');
        expect(await stamps(db, workspace.id)).toMatchObject({ ...expected, seen: '2026-11-11T00:00:00.000Z' });
      });

      test('期限を取り込み元で外すと、更新日時が同じでも映る', async () => {
        const { workspace, connection, db } = await setup();
        const run = (o: Partial<ImportItem>) =>
          syncConnection(env, db, workspace.id, connection.id, {
            source: fakeSource({ '501': [{ items: [item(1, o)], next: null }] }).source,
          });
        await run({ dueOn: '2026-12-10' });
        await run({ dueOn: null });
        expect(await stamps(db, workspace.id)).toMatchObject({ source_due_on: null });
      });
    });

    test('別のワークスペースの同じ項目、レビュー依頼の行、削除したタスクは更新しない', async () => {
      const mine = await setup();
      const theirs = await setup();
      const run = (s: Awaited<ReturnType<typeof setup>>, items: ImportItem[]) =>
        syncConnection(env, s.db, s.workspace.id, s.connection.id, {
          source: fakeSource({ '501': [{ items, next: null }] }).source,
        });
      const review = item(2, { kind: 'review_request', reviewerSourceId: 'r-1', reviewCycle: 'c-1' });
      await run(mine, [item(1), review, item(3)]);
      await run(theirs, [item(1)]);
      const deleted = (await sourcesOf(mine.db, mine.workspace.id)).find((r) => r.source_id === 'src-3')!;
      await mine.db.run(
        mine.db.statement((q) =>
          q.updateTable('tasks').set({ deleted_at: '2026-11-01T02:00:00.000Z' }).where('id', '=', deleted.task_id),
        ),
      );
      const changed = { updatedAt: '2026-11-04T00:00:00.000Z' };
      await run(mine, [
        item(1, { ...changed, title: '自分だけ' }),
        { ...review, ...changed, title: '書き換わらない' },
        item(3, { ...changed, title: '削除済み' }),
      ]);
      const titles = async (s: Awaited<ReturnType<typeof setup>>) =>
        (await tasksOf(s.db, s.workspace.id)).map((t) => t.title).sort();
      expect(await titles(theirs)).toEqual(['項目 1']);
      expect(await titles(mine)).toEqual(['項目 2', '項目 3', '自分だけ'].sort());
    });
  });

  test('並行して同期しても、同じ項目が二重に入らず、片方だけの行も残らない', async () => {
    const { workspace, connection, db } = await setup();
    const pages = { '501': [{ items: [item(1), item(2), item(3)], next: null }] };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        syncConnection(env, db, workspace.id, connection.id, { source: fakeSource(pages).source }),
      ),
    );
    // どれも成功で、入れたのは1つの同期だけ（ガードが無いと、後の同期は一意制約で error になる）
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
    expect(results.map((r) => (r.outcome === 'success' ? r.imported : -1)).sort()).toEqual([0, 0, 0, 3]);
    const tasks = await tasksOf(db, workspace.id);
    const sources = await sourcesOf(db, workspace.id);
    expect(tasks).toHaveLength(3);
    expect(sources).toHaveLength(3);
    expect(new Set(sources.map((s) => s.task_id))).toEqual(new Set(tasks.map((t) => t.id)));
  });

  test('同じ頁の中の同じ項目も1件にまとめ、レビュー依頼はレビュアーごとに分ける', async () => {
    const { workspace, connection, db } = await setup();
    const review = (reviewer: string) =>
      item(9, {
        kind: 'review_request',
        reviewerSourceId: reviewer,
        reviewCycle: 'cycle-1',
        sourceId: 'pr-9',
        key: 'fake/box#9',
      });
    const { source } = fakeSource({
      '501': [{ items: [item(1), item(1), review('u1'), review('u2'), review('u1')], next: null }],
    });
    const result = await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(result).toMatchObject({ outcome: 'success', imported: 3 });
    expect(await sourcesOf(db, workspace.id)).toHaveLength(3);
  });

  test('範囲が空の接続は、取り込み元に問い合わせず何も入れない', async () => {
    const { organization, owner, workspace, db } = await setup();
    const empty = await createConnection(organization, workspace.id, owner.id, { name: '範囲なし' });
    const { source, calls } = fakeSource({ '501': [{ items: [item(1)], next: null }] });
    const result = await syncConnection(env, db, workspace.id, empty.id, { source });
    expect(result).toEqual({ outcome: 'no_scope' });
    expect(calls).toHaveLength(0);
    expect(await tasksOf(db, workspace.id)).toHaveLength(0);
    expect((await connectionOf(db, empty.id)).last_success_at).toBeNull();
  });

  test('除外を挙げる接続は、候補から除外を引いた範囲を取る', async () => {
    const { organization, owner, workspace, db } = await setup();
    const connectionId = uuidv7();
    const sealed = await encryptCredential(env, SECRET, connectionId);
    const connection = await createConnection(organization, workspace.id, owner.id, {
      id: connectionId,
      scope_mode: 'exclude',
      credential_ciphertext: sealed.ciphertext,
      credential_key_version: sealed.keyVersion,
      credential_last4: 'e-01',
    });
    await createConnectionScope(organization, connection.id, { source_id: '502', source_name: 'scope-502' });
    const { source, calls } = fakeSource({
      '501': [{ items: [item(1)], next: null }],
      '502': [{ items: [item(2)], next: null }],
      '503': [{ items: [item(3, { containerId: '503' })], next: null }],
    });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(calls.map((call) => call.scope.id)).toEqual(['501', '503']);
    expect((await sourcesOf(db, workspace.id)).map((s) => s.source_id).sort()).toEqual(['src-1', 'src-3']);
  });

  test('上限で止めたときに続きの位置を保存し、次の同期で残りを入れる', async () => {
    const { workspace, connection, db } = await setup();
    const pages = {
      '501': [
        { items: [item(1), item(2)], next: '1' },
        { items: [item(3)], next: '2' },
        { items: [item(4)], next: null },
      ],
    };
    const first = fakeSource(pages);
    const r1 = await syncConnection(env, db, workspace.id, connection.id, { source: first.source, maxPages: 2 });
    expect(r1).toEqual({ outcome: 'success', imported: 3, more: true });
    expect(first.calls.map((call) => call.cursor)).toEqual([null, '1']);
    expect(JSON.parse((await connectionOf(db, connection.id)).sync_state_json)).toMatchObject({
      position: { scope: '501', cursor: '2' },
    });

    const second = fakeSource(pages);
    const r2 = await syncConnection(env, db, workspace.id, connection.id, { source: second.source, maxPages: 2 });
    expect(r2).toEqual({ outcome: 'success', imported: 1, more: false });
    expect(second.calls.map((call) => call.cursor)).toEqual(['2']);
    expect((await tasksOf(db, workspace.id)).map((t) => t.title)).toEqual(['項目 1', '項目 2', '項目 3', '項目 4']);
    expect((await connectionOf(db, connection.id)).sync_state_json).toBe('{}');
  });

  test('認証の失敗で接続が停止になり、エラーの文に認証情報が含まれない', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({}, { fail: 'unauthorized' });
    const result = await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(result).toEqual({ outcome: 'auth_failed', imported: 0 });
    const after = await connectionOf(db, connection.id);
    expect(after).toMatchObject({ status: 'stopped', stopped_reason: 'auth_failed' });
    expect(after.last_error_message).toBeTruthy();
    expect(after.last_error_at).not.toBeNull();
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(after)).not.toContain('leak.example');

    // 止まった接続は、次の同期で取り込み元に問い合わせない
    const next = fakeSource({ '501': [{ items: [item(1)], next: null }] });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: next.source })).toEqual({
      outcome: 'stopped',
    });
    expect(next.calls).toHaveLength(0);
  });

  test.each<ImportSourceFailure>(['forbidden', 'unavailable'])(
    '%s の失敗は止めず、エラーと失敗の回数と固定の文を書く。次の成功で戻る',
    async (failure) => {
      const { workspace, connection, db } = await setup();
      const bad = fakeSource({}, { fail: failure });
      expect(await syncConnection(env, db, workspace.id, connection.id, { source: bad.source })).toEqual({
        outcome: 'error',
        imported: 0,
      });
      await syncConnection(env, db, workspace.id, connection.id, { source: bad.source });
      const failed = await connectionOf(db, connection.id);
      expect(failed).toMatchObject({ status: 'error', stopped_reason: null, consecutive_failures: 2 });
      expect(failed.last_error_message).toBeTruthy();
      expect(JSON.stringify(failed)).not.toContain(SECRET);
      expect(JSON.stringify(failed)).not.toContain('leak.example');

      const good = fakeSource({ '501': [{ items: [item(1)], next: null }] });
      await syncConnection(env, db, workspace.id, connection.id, { source: good.source });
      expect(await connectionOf(db, connection.id)).toMatchObject({
        status: 'active',
        consecutive_failures: 0,
        last_error_message: null,
        last_error_at: null,
      });
    },
  );

  test('想定外の例外も固定の文で書く。復号できない認証情報は止めずにエラーにする', async () => {
    const { organization, owner, workspace, db } = await setup();
    const throwing: ImportSource = {
      ...fakeSource({}).source,
      async fetchPage() {
        throw new Error(`boom ${SECRET}`);
      },
    };
    const connection = await createConnection(organization, workspace.id, owner.id, {
      credential_ciphertext: 'AAAA',
      credential_key_version: 1,
      credential_last4: 'AAAA',
    });
    await createConnectionScope(organization, connection.id);
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: throwing })).toEqual({
      outcome: 'error',
      imported: 0,
    });
    const after = await connectionOf(db, connection.id);
    expect(after).toMatchObject({ status: 'error', consecutive_failures: 1 });
    expect(after.last_error_message).not.toContain(SECRET);
  });

  test('進まない続きの位置は断る', async () => {
    const { workspace, connection, db } = await setup();
    let calls = 0;
    const stuck: ImportSource = {
      ...fakeSource({}).source,
      async fetchPage() {
        calls++;
        return { items: [], next: '0' };
      },
    };
    const result = await syncConnection(env, db, workspace.id, connection.id, { source: stuck });
    expect(result).toEqual({ outcome: 'error', imported: 0 });
    // 最初の頁（cursor は null）の次の '0' を返し、その次で同じ位置を返したと分かって断る
    expect(calls).toBe(2);
  });

  test.each([
    ['javascript の URL', { url: 'javascript:alert(1)' }],
    ['URL でない文字列', { url: 'not a url' }],
    ['ISO 8601 でない更新日時', { updatedAt: '2026/11/01' }],
    ['暦に無い期日', { dueOn: '2026-02-30' }],
    ['見えない文字だけのキー', { key: '\u{200B}' }],
    ['見えない文字だけの状態', { status: '\u0000' }],
    ['詰め物の文字だけの状態', { status: '\u3164' }],
    ['点字の空白だけの入れ物の名前', { containerName: '\u2800' }],
    ['空の入れ物の名前', { containerName: '' }],
  ])('%s の項目は飛ばし、ほかの項目は入れる', async (_name, overrides) => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({ '501': [{ items: [item(1), item(2, overrides)], next: null }] });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toEqual({
      outcome: 'success',
      imported: 1,
      more: false,
    });
    expect((await tasksOf(db, workspace.id)).map((t) => t.title)).toEqual(['項目 1']);
  });

  test('2頁目に形の悪い項目があっても、後の頁と別の範囲を取り込む', async () => {
    const { organization, owner, workspace, db } = await setup();
    const connectionId = uuidv7();
    const sealed = await encryptCredential(env, SECRET, connectionId);
    const connection = await createConnection(organization, workspace.id, owner.id, {
      id: connectionId,
      credential_ciphertext: sealed.ciphertext,
      credential_key_version: sealed.keyVersion,
      credential_last4: 'e-01',
    });
    await createConnectionScope(organization, connection.id, { source_id: '501', source_name: 'a' });
    await createConnectionScope(organization, connection.id, { source_id: '502', source_name: 'b' });
    const { source } = fakeSource({
      '501': [
        { items: [item(1)], next: '1' },
        { items: [item(2, { key: 'k'.repeat(2001) }), item(3)], next: null },
      ],
      '502': [{ items: [item(4)], next: null }],
    });
    const result = await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(result).toEqual({ outcome: 'success', imported: 3, more: false });
  });

  test('ミリ秒なしの Z や UTC からのずれ付きの更新日時も受け、ミリ秒付きの UTC に直して保存する', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({
      '501': [
        {
          items: [item(1, { updatedAt: '2026-11-01T00:00:00Z' }), item(2, { updatedAt: '2026-11-01T09:00:00+09:00' })],
          next: null,
        },
      ],
    });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toMatchObject({ imported: 2 });
    const rows = await db.rows(
      db.statement((q) =>
        q.selectFrom('task_sources').select('source_updated_at').where('workspace_id', '=', workspace.id),
      ),
    );
    expect(rows.map((r) => r.source_updated_at)).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']);
  });

  test('空に見えるタイトルはキーに替え、200字の切れ目の空白を残さない', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({
      '501': [
        {
          items: [
            item(1, { title: '\u3164' }),
            item(2, { title: '\u{200D}' }),
            item(3, { title: `${'a'.repeat(199)} bcd` }),
            item(4, { title: `${'\u3164'.repeat(200)}a` }),
          ],
          next: null,
        },
      ],
    });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    const titles = (await tasksOf(db, workspace.id)).map((t) => t.title);
    expect(titles).toContain('fake/box#1');
    expect(titles).toContain('fake/box#2');
    expect(titles).toContain('a'.repeat(199));
    expect(titles).toContain('fake/box#4');
  });

  test('100件の頁は入り、101件の頁は断る', async () => {
    const { workspace, connection, db } = await setup();
    const many = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1));
    const ok = fakeSource({ '501': [{ items: many(100), next: null }] });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: ok.source })).toMatchObject({
      outcome: 'success',
      imported: 100,
    });
    const over = fakeSource({ '501': [{ items: many(101), next: null }] });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: over.source })).toEqual({
      outcome: 'error',
      imported: 0,
    });
  });

  test('2つ目の範囲の先頭で上限に当たったとき、次の同期は2つ目の範囲から始める', async () => {
    const { organization, owner, workspace, db } = await setup();
    const connectionId = uuidv7();
    const sealed = await encryptCredential(env, SECRET, connectionId);
    const connection = await createConnection(organization, workspace.id, owner.id, {
      id: connectionId,
      credential_ciphertext: sealed.ciphertext,
      credential_key_version: sealed.keyVersion,
      credential_last4: 'e-01',
    });
    await createConnectionScope(organization, connection.id, { source_id: '501', source_name: 'a' });
    await createConnectionScope(organization, connection.id, { source_id: '502', source_name: 'b' });
    const pages = {
      '501': [
        { items: [item(1)], next: '1' },
        { items: [item(2)], next: null },
      ],
      '502': [{ items: [item(3)], next: null }],
    };
    const first = fakeSource(pages);
    await syncConnection(env, db, workspace.id, connection.id, { source: first.source, maxPages: 2 });
    const second = fakeSource(pages);
    const result = await syncConnection(env, db, workspace.id, connection.id, { source: second.source, maxPages: 2 });
    expect(result).toEqual({ outcome: 'success', imported: 1, more: false });
    expect(second.calls.map((call) => `${call.scope.id}:${call.cursor}`)).toEqual(['502:null']);
  });

  test('認証情報の形が違う失敗も接続を停止にする', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({}, { fail: 'invalid_format' });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toEqual({
      outcome: 'auth_failed',
      imported: 0,
    });
    expect(await connectionOf(db, connection.id)).toMatchObject({ status: 'stopped', stopped_reason: 'auth_failed' });
  });

  test('抜けた登録者の接続と、閉じたワークスペース、削除した接続は同期しない', async () => {
    const left = await setup();
    await left.db.run(
      left.db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: '2026-11-02T00:00:00.000Z', left_on: '2026-11-02' })
          .where('user_id', '=', left.owner.id),
      ),
    );
    const closed = await setup();
    await closed.db.run(
      closed.db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-11-02T00:00:00.000Z' })
          .where('id', '=', closed.workspace.id),
      ),
    );
    const deleted = await setup();
    await deleted.db.run(
      deleted.db.statement((q) =>
        q
          .updateTable('connections')
          .set({
            deleted_at: '2026-11-02T00:00:00.000Z',
            credential_ciphertext: null,
            credential_key_version: null,
            credential_last4: null,
          })
          .where('id', '=', deleted.connection.id),
      ),
    );
    const { source, calls } = fakeSource({ '501': [{ items: [item(1)], next: null }] });
    for (const t of [left, closed, deleted]) {
      expect(await syncConnection(env, t.db, t.workspace.id, t.connection.id, { source })).toEqual({
        outcome: 'not_found',
      });
      expect(await tasksOf(t.db, t.workspace.id)).toHaveLength(0);
    }
    expect(calls).toHaveLength(0);
  });

  test('読んだ後に登録者が抜けたら、取り込まない', async () => {
    const { owner, workspace, connection, db } = await setup();
    const leaveMidway: ImportSource = {
      ...fakeSource({}).source,
      async fetchPage() {
        await db.run(
          db.statement((q) =>
            q
              .updateTable('memberships')
              .set({ left_at: '2026-11-02T00:00:00.000Z', left_on: '2026-11-02' })
              .where('user_id', '=', owner.id),
          ),
        );
        return { items: [item(1)], next: null };
      },
    };
    const result = await syncConnection(env, db, workspace.id, connection.id, { source: leaveMidway });
    expect(result).toMatchObject({ imported: 0 });
    expect(await tasksOf(db, workspace.id)).toHaveLength(0);
    expect(await sourcesOf(db, workspace.id)).toHaveLength(0);
  });

  test('無効にされた登録者の接続は同期しない', async () => {
    const { owner, workspace, connection, db } = await setup();
    await db.run(
      db.statement((q) =>
        q.updateTable('users').set({ disabled_at: '2026-11-02T00:00:00.000Z' }).where('id', '=', owner.id),
      ),
    );
    const { source, calls } = fakeSource({ '501': [{ items: [item(1)], next: null }] });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toEqual({ outcome: 'not_found' });
    expect(calls).toHaveLength(0);
  });

  test('取り込み元を呼んでいる間にリポジトリが削除されたら結ばない', async () => {
    const { organization, workspace, connection, db } = await setup();
    const repo = await createRepository(organization, workspace.id, {
      provider: 'github',
      source_container_id: '501',
      source_container_name: 'fake/box',
    });
    const deleteMidway: ImportSource = {
      ...fakeSource({}).source,
      async fetchPage() {
        await db.run(
          db.statement((q) =>
            q.updateTable('repositories').set({ deleted_at: '2026-11-02T00:00:00.000Z' }).where('id', '=', repo.id),
          ),
        );
        return { items: [item(1)], next: null };
      },
    };
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: deleteMidway })).toMatchObject({
      outcome: 'success',
      imported: 1,
    });
    expect((await tasksOf(db, workspace.id))[0]!.repository_id).toBeNull();
  });

  test('ちょうど上限の頁数で最後の範囲が終われば、続きを残さない', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({
      '501': [
        { items: [item(1)], next: '1' },
        { items: [item(2)], next: null },
      ],
    });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source, maxPages: 2 })).toEqual({
      outcome: 'success',
      imported: 2,
      more: false,
    });
    expect((await connectionOf(db, connection.id)).sync_state_json).toBe('{}');
  });

  test('結んだリポジトリが削除されていれば結ばない', async () => {
    const { organization, workspace, connection, db } = await setup();
    await createRepository(organization, workspace.id, {
      provider: 'github',
      source_container_id: '501',
      source_container_name: 'fake/box',
      deleted_at: '2026-11-02T00:00:00.000Z',
    });
    const { source } = fakeSource({ '501': [{ items: [item(1)], next: null }] });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    expect((await tasksOf(db, workspace.id))[0]!.repository_id).toBeNull();
  });

  test('別の組織の接続には触れない。別のワークスペースの接続も同じ', async () => {
    const mine = await setup();
    const theirs = await setup();
    const { source, calls } = fakeSource({ '501': [{ items: [item(1)], next: null }] });

    // 別の組織の入口から、自分の組織の接続を指す
    expect(await syncConnection(env, theirs.db, mine.workspace.id, mine.connection.id, { source })).toEqual({
      outcome: 'not_found',
    });
    // 同じ組織でも、別のワークスペースの ID では見つからない
    const other = await createWorkspace(mine.organization, mine.owner.id);
    expect(await syncConnection(env, mine.db, other.id, mine.connection.id, { source })).toEqual({
      outcome: 'not_found',
    });
    expect(calls).toHaveLength(0);

    await syncConnection(env, mine.db, mine.workspace.id, mine.connection.id, { source });
    expect(await tasksOf(mine.db, mine.workspace.id)).toHaveLength(1);
    expect(await tasksOf(theirs.db, theirs.workspace.id)).toHaveLength(0);
    expect(await sourcesOf(theirs.db, theirs.workspace.id)).toHaveLength(0);
    expect((await connectionOf(theirs.db, theirs.connection.id)).last_success_at).toBeNull();
  });

  test('同期の最中に止まった接続には、成功も取り込みも書かない', async () => {
    const { workspace, connection, db } = await setup();
    const stopMidway: ImportSource = {
      ...fakeSource({}).source,
      async fetchPage() {
        await db.run(
          db.statement((q) =>
            q
              .updateTable('connections')
              .set({ status: 'stopped', stopped_reason: 'leader' })
              .where('id', '=', connection.id),
          ),
        );
        return { items: [item(1)], next: null };
      },
    };
    await syncConnection(env, db, workspace.id, connection.id, { source: stopMidway });
    expect(await tasksOf(db, workspace.id)).toHaveLength(0);
    expect(await connectionOf(db, connection.id)).toMatchObject({ status: 'stopped', stopped_reason: 'leader' });
  });
});
