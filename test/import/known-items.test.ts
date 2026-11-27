// #1543: 担当が外れた項目と範囲の外へ移した項目を、不変の ID で取りに行って同期を続ける。
// 取り込み元の取得口（GitHub の fetchKnownItem）と、本物の同期の保存・再開を、偽 GitHub でつなぐ。
// 例のデータはすべて架空
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../../src/server/db/index.ts';
import { encryptCredential } from '../../src/server/crypto/credential.ts';
import { importSourceOf } from '../../src/server/import/index.ts';
import { ImportSourceError } from '../../src/server/import/source.ts';
import { syncConnection } from '../../src/server/import/sync.ts';
import {
  createConnection,
  createConnectionScope,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  uuidv7,
} from '../factories.ts';
import { fakeIssue } from './fake-github-pat.ts';
import { fakePull, PULL_LOGIN, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

const source = importSourceOf('github');
const OTHER_SCOPE = { id: '2002', name: 'guild-fake/beta' };

type Raw = Record<string, unknown>;
// 1件の引き口の応答。moved は 301 の移動先、status は失敗の状態、どちらも無ければ本文
type Route = Raw;

// 一覧（担当の Issue）と、保存した入れ物のリポジトリ ID・番号で1件を引く口を持つ偽の GitHub
function fakeGithub() {
  const calls: string[] = [];
  const issues = new Map<string, Raw[]>();
  const single = new Map<string, Route>();
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.origin !== 'https://api.github.com') throw new Error('想定外のホスト');
    if (url.pathname === '/user') return Response.json({ type: 'User', id: 42, login: PULL_LOGIN });
    const list = /^\/repositories\/(\d+)\/(issues|pulls)$/.exec(url.pathname);
    if (list) {
      if (list[2] === 'pulls') return Response.json([]);
      const assignee = url.searchParams.get('assignee');
      const rows = (issues.get(list[1]!) ?? []).filter((item) =>
        ((item.assignees ?? []) as { login: string }[]).some((a) => a.login === assignee),
      );
      return Response.json(rows);
    }
    const one = /^\/repositories\/(\d+)\/(issues|pulls)\/(\d+)$/.exec(url.pathname);
    const route = one ? single.get(url.pathname) : undefined;
    if (route === undefined) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (typeof route.moved === 'string') return new Response(null, { status: 301, headers: { Location: route.moved } });
    if (typeof route.status === 'number') return Response.json({ message: 'denied' }, { status: route.status });
    return Response.json(route);
  };
  return { calls, issues, single, fetcher };
}

async function setup(scopes = [PULL_SCOPE]) {
  const organization = await createOrganization();
  const owner = await createUser(organization);
  const workspace = await createWorkspace(organization, owner.id);
  await createMembership(organization, workspace.id, owner.id);
  const db = orgDb(env, organization.verified);
  const id = uuidv7();
  const sealed = await encryptCredential(env, PULL_PAT, id);
  await createConnection(organization, workspace.id, owner.id, {
    id,
    credential_ciphertext: sealed.ciphertext,
    credential_key_version: sealed.keyVersion,
    credential_last4: PULL_PAT.slice(-4),
  });
  for (const scope of scopes) {
    await createConnectionScope(organization, id, { source_id: scope.id, source_name: scope.name });
  }
  const sync = (f: ReturnType<typeof fakeGithub>, options: { maxPages?: number } = {}) =>
    syncConnection(env, db, workspace.id, id, { fetcher: f.fetcher, ...options });
  const sources = () =>
    db.rows(
      db.statement((q) =>
        q.selectFrom('task_sources').selectAll().where('workspace_id', '=', workspace.id).orderBy('source_id'),
      ),
    );
  const tasks = () =>
    db.rows(db.statement((q) => q.selectFrom('tasks').selectAll().where('workspace_id', '=', workspace.id)));
  const state = async () =>
    (await db.first(db.statement((q) => q.selectFrom('connections').select('sync_state_json').where('id', '=', id))))
      ?.sync_state_json;
  return { db, workspace, id, sync, sources, tasks, state };
}

// 1001 のリポジトリの Issue n を、一覧と1件の引き口の両方に置く
function put(f: ReturnType<typeof fakeGithub>, scope: { id: string; name: string }, n: number, patch: Raw = {}) {
  const issue: Raw = { ...fakeIssue(scope.name, n), ...patch };
  const list = f.issues.get(scope.id) ?? [];
  f.issues.set(scope.id, [...list.filter((item) => item.id !== issue.id), issue]);
  f.single.set(`/repositories/${scope.id}/issues/${n}`, issue);
  return issue;
}

describe('取り込み元: 保存済みの項目を不変の ID で取る', () => {
  const target = {
    kind: 'issue' as 'issue' | 'pull_request',
    sourceId: '500001',
    key: 'guild-fake/alpha#1',
    containerId: PULL_SCOPE.id,
    containerName: PULL_SCOPE.name,
  };
  const call = (f: ReturnType<typeof fakeGithub>, patch: Partial<typeof target> = {}) =>
    source.fetchKnownItem!({
      credential: PULL_PAT,
      fetcher: f.fetcher,
      settings: {},
      target: { ...target, ...patch },
    });

  test('担当が外れた Issue も、リポジトリの ID と番号の1要求で、現在の属性と完了の印つきで返す', async () => {
    const f = fakeGithub();
    put(f, PULL_SCOPE, 1, {
      title: '改題した課題',
      assignees: [],
      assignee: null,
      state: 'closed',
      milestone: { due_on: '2026-12-01T00:00:00Z' },
    });
    const item = await call(f);
    expect(item).toMatchObject({
      kind: 'issue',
      sourceId: '500001',
      title: '改題した課題',
      status: 'closed',
      isDone: true,
      dueOn: '2026-12-01',
    });
    expect(f.calls).toEqual(['/repositories/1001/issues/1']);
  });

  test('応答の ID が保存した ID と違う（番号の再利用など）ときは、別の項目として断る', async () => {
    const f = fakeGithub();
    put(f, PULL_SCOPE, 1, { id: 999 });
    await expect(call(f)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  test('Issue の ID に PR が返る応答は断る', async () => {
    const f = fakeGithub();
    put(f, PULL_SCOPE, 1, { pull_request: { url: 'https://api.github.com/repos/guild-fake/alpha/pulls/1' } });
    await expect(call(f)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  test('PR は pulls の口で、作者や担当を見ずにマージ済みの印つきで返す', async () => {
    const f = fakeGithub();
    f.single.set(
      '/repositories/1001/pulls/3',
      fakePull(3, {
        user: { id: 99, login: 'fake-other' },
        assignees: [],
        state: 'closed',
        merged_at: '2026-06-01T00:00:00Z',
      }),
    );
    const item = await call(f, { kind: 'pull_request', sourceId: '800003', key: 'guild-fake/alpha#3' });
    expect(item).toMatchObject({ kind: 'pull_request', sourceId: '800003', status: 'merged', isDone: true });
  });

  test('別のリポジトリへ移した Issue は、移動先が api.github.com の同じ形のときだけ1回追う', async () => {
    const f = fakeGithub();
    f.single.set('/repositories/1001/issues/1', { moved: 'https://api.github.com/repositories/2002/issues/7' });
    put(f, OTHER_SCOPE, 7, { id: 500_001, title: '移した課題' });
    const item = await call(f);
    expect(item).toMatchObject({
      sourceId: '500001',
      title: '移した課題',
      url: 'https://github.com/guild-fake/beta/issues/7',
    });
    expect(f.calls).toEqual(['/repositories/1001/issues/1', '/repositories/2002/issues/7']);
  });

  test.each([
    'https://evil.example/repositories/2002/issues/7',
    'http://api.github.com/repositories/2002/issues/7',
    'https://api.github.com/repositories/2002/issues/7?x=1',
    'https://user@api.github.com/repositories/2002/issues/7',
    'https://api.github.com/user',
  ])('移動先が想定の形でなければ追わない: %s', async (moved) => {
    const f = fakeGithub();
    f.single.set('/repositories/1001/issues/1', { moved });
    await expect(call(f)).rejects.toBeInstanceOf(ImportSourceError);
    expect(f.calls).toEqual(['/repositories/1001/issues/1']);
  });

  test('追った先がまた移動を返しても、それ以上は追わない', async () => {
    const f = fakeGithub();
    f.single.set('/repositories/1001/issues/1', { moved: 'https://api.github.com/repositories/2002/issues/7' });
    f.single.set('/repositories/2002/issues/7', { moved: 'https://api.github.com/repositories/3003/issues/9' });
    await expect(call(f)).rejects.toMatchObject({ failure: 'unavailable' });
    expect(f.calls).toHaveLength(2);
  });

  test('権限で断られたときは forbidden、見つからないときは unavailable で投げる', async () => {
    const f = fakeGithub();
    f.single.set('/repositories/1001/issues/1', { status: 403 });
    await expect(call(f)).rejects.toMatchObject({ failure: 'forbidden' });
    await expect(call(f, { key: 'guild-fake/alpha#2', sourceId: '500002' })).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });

  test('保存した値の形が合わなければ、通信せずに TypeError にする', async () => {
    const f = fakeGithub();
    await expect(call(f, { key: 'alpha#1' })).rejects.toBeInstanceOf(TypeError);
    await expect(call(f, { containerId: '../user' })).rejects.toBeInstanceOf(TypeError);
    expect(f.calls).toEqual([]);
  });
});

describe('同期: 担当が外れた項目と範囲の外へ移した項目', () => {
  test('GitHub で担当を外した項目のタイトル、期限、状態の変化が、次の同期でタスクに映る', async () => {
    const t = await setup();
    const f = fakeGithub();
    put(f, PULL_SCOPE, 1);
    expect(await t.sync(f)).toEqual({ outcome: 'success', imported: 1, more: false });
    expect((await t.tasks()).map((task) => task.title)).toEqual(['架空の課題 1']);

    // 担当を外し、題と期限を変え、閉じる。担当の一覧には出なくなる
    put(f, PULL_SCOPE, 1, {
      assignees: [],
      assignee: null,
      title: '担当が外れた課題',
      milestone: { due_on: '2026-12-24T00:00:00Z' },
      state: 'closed',
      updated_at: '2026-12-01T00:00:00.000Z',
    });
    f.issues.set(PULL_SCOPE.id, []);
    expect(await t.sync(f)).toEqual({ outcome: 'success', imported: 0, more: false });

    expect((await t.tasks()).map((task) => task.title)).toEqual(['担当が外れた課題']);
    expect(await t.sources()).toMatchObject([
      {
        source_status: 'closed',
        source_due_on: '2026-12-24',
        is_source_done: 1,
        source_updated_at: '2026-12-01T00:00:00.000Z',
      },
    ]);
    expect(await t.state()).toBe('{}');
  });

  test('範囲の外のリポジトリへ移した項目も、次の同期で同じく映る', async () => {
    const t = await setup();
    const f = fakeGithub();
    put(f, PULL_SCOPE, 1);
    await t.sync(f);

    // 1001 の Issue を 2002（範囲の外）へ移す。古い口は移動先を指し、移動先は担当が外れている
    f.issues.set(PULL_SCOPE.id, []);
    f.single.set('/repositories/1001/issues/1', { moved: 'https://api.github.com/repositories/2002/issues/7' });
    put(f, OTHER_SCOPE, 7, {
      id: 500_001,
      assignees: [],
      assignee: null,
      title: '範囲の外へ移した課題',
      updated_at: '2026-12-02T00:00:00.000Z',
    });
    f.issues.set(OTHER_SCOPE.id, []);
    expect(await t.sync(f)).toMatchObject({ outcome: 'success', more: false });

    expect((await t.tasks()).map((task) => task.title)).toEqual(['範囲の外へ移した課題']);
    expect(await t.sources()).toMatchObject([
      { source_url: 'https://github.com/guild-fake/beta/issues/7', source_status: 'open' },
    ]);
  });

  test('範囲から外したリポジトリの項目も、保存した入れ物の ID で取りに行く', async () => {
    const t = await setup([PULL_SCOPE, OTHER_SCOPE]);
    const f = fakeGithub();
    put(f, OTHER_SCOPE, 5);
    await t.sync(f);
    expect(await t.sources()).toHaveLength(1);

    // 範囲を 1001 だけにし、2002 の項目の題が変わる
    await t.db.batch([
      t.db.statement((q) =>
        q.deleteFrom('connection_scopes').where('connection_id', '=', t.id).where('source_id', '=', OTHER_SCOPE.id),
      ),
    ]);
    put(f, OTHER_SCOPE, 5, { title: '範囲から外れた後の題', updated_at: '2026-12-03T00:00:00.000Z' });
    f.issues.set(OTHER_SCOPE.id, []);
    await t.sync(f);
    expect((await t.tasks()).map((task) => task.title)).toEqual(['範囲から外れた後の題']);
  });

  test('上限で止まった同期は、次の回で続きの項目から取りに行く', async () => {
    const t = await setup();
    const f = fakeGithub();
    for (const n of [1, 2, 3]) put(f, PULL_SCOPE, n);
    await t.sync(f);
    const ids = (await t.sources()).map((s) => s.task_id).sort();
    expect(ids).toHaveLength(3);

    // 3件とも担当が外れて題が変わる。1回に取れるのは、発見の走査が使った分を除いて1項目
    for (const n of [1, 2, 3])
      put(f, PULL_SCOPE, n, {
        assignees: [],
        assignee: null,
        title: `改題 ${n}`,
        updated_at: '2026-12-04T00:00:00.000Z',
      });
    f.issues.set(PULL_SCOPE.id, []);
    f.calls.length = 0;
    // 発見の走査は4回の取得口の呼び出し（Issue、PR、レビュー依頼の本人照会と一覧）。5回目の1項目だけ取って止まる
    const first = await t.sync(f, { maxPages: 5 });
    expect(first).toEqual({ outcome: 'success', imported: 0, more: true });
    const known = () => f.calls.filter((c) => /\/issues\/\d+$/.test(c));
    expect(known()).toHaveLength(1);
    expect(JSON.parse((await t.state())!)).toMatchObject({ version: 2, known: { after: expect.any(String) } });
    expect((await t.tasks()).filter((task) => task.title.startsWith('改題'))).toHaveLength(1);

    // 次の回は、発見の走査をやり直さず、続きの項目から取りに行く（取った項目をもう一度取らない）
    const firstCalls = known();
    f.calls.length = 0;
    expect(await t.sync(f, { maxPages: 2 })).toEqual({ outcome: 'success', imported: 0, more: true });
    expect(f.calls.filter((c) => !/\/issues\/\d+$/.test(c))).toEqual([]);
    expect(known()).toHaveLength(2);
    expect(new Set([...firstCalls, ...known()]).size).toBe(3);
    expect((await t.tasks()).filter((task) => task.title.startsWith('改題'))).toHaveLength(3);
    expect(await t.sync(f, { maxPages: 2 })).toEqual({ outcome: 'success', imported: 0, more: false });
    expect(await t.state()).toBe('{}');
  });

  test('権限で断られた項目と見つからない項目は動かさず、ほかの項目は取りに行く', async () => {
    const t = await setup();
    const f = fakeGithub();
    for (const n of [1, 2, 3]) put(f, PULL_SCOPE, n);
    await t.sync(f);
    const before = await t.sources();
    const titleBefore = (await t.tasks()).map((task) => task.title).sort();

    for (const n of [1, 2, 3]) put(f, PULL_SCOPE, n, { title: `改題 ${n}`, updated_at: '2026-12-05T00:00:00.000Z' });
    f.issues.set(PULL_SCOPE.id, []);
    const order = (await t.sources()).map((s) => [s.task_id, s.source_id] as const).sort();
    // task_id の順で、先頭は権限で断られ、2番目は見つからず、最後だけ取れる
    f.single.set(`/repositories/1001/issues/${Number(order[0]![1]) - 500_000}`, { status: 403 });
    f.single.delete(`/repositories/1001/issues/${Number(order[1]![1]) - 500_000}`);
    expect(await t.sync(f)).toEqual({ outcome: 'success', imported: 0, more: false });

    const after = await t.sources();
    const byId = (rows: typeof before, id: string) => rows.find((s) => s.source_id === id)!;
    for (const [, sourceId] of order.slice(0, 2)) {
      expect(byId(after, sourceId)).toEqual(byId(before, sourceId));
    }
    const titles = (await t.tasks()).map((task) => task.title);
    expect(titles.filter((title) => title.startsWith('改題'))).toHaveLength(1);
    expect(titleBefore.filter((title) => titles.includes(title))).toHaveLength(2);
    // 接続はエラーにも停止にもしない
    expect(await t.state()).toBe('{}');
  });

  test('完了の印が付いた項目は取りに行かない', async () => {
    const t = await setup();
    const f = fakeGithub();
    put(f, PULL_SCOPE, 1, { state: 'closed' });
    f.issues.set(PULL_SCOPE.id, [f.issues.get(PULL_SCOPE.id)![0]!]);
    await t.sync(f);
    // 閉じた項目は新しく取り込まない
    expect(await t.sources()).toEqual([]);
    put(f, PULL_SCOPE, 2);
    await t.sync(f);
    await t.db.batch([
      t.db.statement((q) =>
        q.updateTable('task_sources').set({ is_source_done: 1 }).where('workspace_id', '=', t.workspace.id),
      ),
    ]);
    // 発見の走査に出ない（担当が外れた）ようにして、完了の印が外れないことも確かめる
    f.issues.set(PULL_SCOPE.id, []);
    f.calls.length = 0;
    await t.sync(f);
    expect(f.calls.filter((c) => /\/issues\/\d+$/.test(c))).toEqual([]);
  });
});
