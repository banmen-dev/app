// #1542 の受け入れテスト。同期の始めは前回の成功から少し戻した時点（since）から、Issue は since を付けて、PR は更新日時の降順で起点に達したら打ち切って取る。
// 偽の fetch で、GitHub の要求の URL と頁を見る。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../../src/server/db/index.ts';
import { encryptCredential } from '../../src/server/crypto/credential.ts';
import { importSourceOf } from '../../src/server/import/index.ts';
import { SINCE_MARGIN_MS, syncConnection } from '../../src/server/import/sync.ts';
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
import { fakePull, ownPullFixture, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';
import { discoveryOnly } from './discovery-only.ts';

const source = importSourceOf('github');
const BASE = Date.UTC(2026, 5, 1, 0, 0, 0);
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
type Fixture = ReturnType<typeof ownPullFixture>;
// 除外で持つ接続の範囲の一覧を、偽の GitHub に頼らず固定する
const allScopes = {
  ...source,
  fetchScopeCandidatesPage: undefined,
  listScopeCandidates: async () => [PULL_SCOPE],
};

function listCalls(f: Fixture, kind: 'issues' | 'pulls') {
  return f.calls
    .map((c) => new URL(c.url))
    .filter((u) => u.pathname.endsWith(`/${kind}`) && u.searchParams.has('page'));
}

function fetchPage(f: Fixture, cursor: string | null, since: string | null | undefined) {
  return source.fetchPage({
    credential: PULL_PAT,
    fetcher: f.fetcher,
    scope: PULL_SCOPE,
    settings: { login: 'fake-ranger' },
    cursor,
    ...(since === undefined ? {} : { since }),
  });
}

describe('取り込み元: 差分の起点', () => {
  test('Issue は同期の始めに起点を since に付け、起点が無ければ付けない', async () => {
    const f = ownPullFixture();
    await fetchPage(f, null, at(10));
    const first = listCalls(f, 'issues')[0]!;
    expect(first.searchParams.get('since')).toBe(at(10));
    expect(first.searchParams.get('page')).toBe('1');

    const g = ownPullFixture();
    await fetchPage(g, null, null);
    expect(listCalls(g, 'issues')[0]!.searchParams.has('since')).toBe(false);
  });

  test('Issue の続きの頁は、起点ではなく読んだ最後の更新日時から1秒戻して読む', async () => {
    const f = ownPullFixture();
    f.data.issues = Array.from({ length: 100 }, (_, i) => fakeIssue(PULL_SCOPE.name, i + 1, { updatedAt: at(20 + i) }));
    const first = await fetchPage(f, null, at(10));
    expect(first.next).toBe(`v2:issues:42:fake-ranger:1:${at(20 + 99)}`);
    await fetchPage(f, first.next, at(10));
    const second = listCalls(f, 'issues')[1]!;
    expect(second.searchParams.get('since')).toBe(new Date(BASE + (20 + 99) * 60_000 - 1000).toISOString());
  });

  test('PR は更新日時の降順に読み、起点より古い項目に達したら頁を打ち切る（起点ちょうどは読む）', async () => {
    const f = ownPullFixture();
    // 更新日時は n 分後。n = 1..250
    f.data.pulls = Array.from({ length: 250 }, (_, i) => fakePull(i + 1, { updated_at: at(i + 1) }));
    // 起点は150分。150..250 の101件だけが対象
    const first = await fetchPage(f, null, at(150));
    // 本人照会の後に PR の最初の頁（Issue は空なので PR の段階へ進む）
    let cursor = first.next;
    const ids = new Set<string>(first.items.map((i) => i.sourceId));
    for (let step = 0; step < 10 && cursor !== null; step++) {
      const page = await fetchPage(f, cursor, at(150));
      page.items.forEach((i) => ids.add(i.sourceId));
      cursor = page.next;
    }
    expect([...ids].sort()).toEqual(Array.from({ length: 101 }, (_, i) => String(800_000 + 150 + i)).sort());
    const pulls = listCalls(f, 'pulls');
    expect(pulls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2']);
    expect(pulls[0]!.searchParams.get('sort')).toBe('updated');
    expect(pulls[0]!.searchParams.get('direction')).toBe('desc');
  });

  test('PR は起点が無ければ最後の頁まで読む', async () => {
    const f = ownPullFixture();
    f.data.pulls = Array.from({ length: 250 }, (_, i) => fakePull(i + 1, { updated_at: at(i + 1) }));
    let cursor: string | null = null;
    const ids = new Set<string>();
    for (let step = 0; step < 10; step++) {
      const page = await fetchPage(f, cursor, null);
      page.items.forEach((i) => ids.add(i.sourceId));
      cursor = page.next;
      if (cursor === null) break;
    }
    expect(ids.size).toBe(250);
    expect(listCalls(f, 'pulls').map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3']);
  });
});

async function setup(options: { lastSuccessAt?: string | null; scopeMode?: 'include' | 'exclude' } = {}) {
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
    last_success_at: options.lastSuccessAt ?? null,
    ...(options.scopeMode === undefined ? {} : { scope_mode: options.scopeMode }),
  });
  // 除外で持つ接続の範囲の行は除外の対象なので、置かない
  if (options.scopeMode !== 'exclude') {
    await createConnectionScope(organization, id, { source_id: PULL_SCOPE.id, source_name: PULL_SCOPE.name });
  }
  const read = () => db.first(db.statement((q) => q.selectFrom('connections').selectAll().where('id', '=', id)));
  const sources = () =>
    db.rows(db.statement((q) => q.selectFrom('task_sources').selectAll().where('workspace_id', '=', workspace.id)));
  return { db, workspace, id, read, sources };
}

describe('同期: 前回成功した時点からの差分', () => {
  test('初めての同期（last_success_at が空）は起点を付けず全部を読み、終わったら last_success_at が入る', async () => {
    const t = await setup();
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 1, { updatedAt: at(1) })];
    f.data.pulls = [fakePull(1, { updated_at: at(1) })];
    const result = await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher });
    expect(result).toEqual({ outcome: 'success', imported: 2, more: false });
    expect(listCalls(f, 'issues')[0]!.searchParams.has('since')).toBe(false);
    expect((await t.read())?.last_success_at).not.toBeNull();
  });

  test('2回目以降は前回の成功から少し戻した時点より後に更新された項目だけを取りに行く', async () => {
    const last = at(100);
    const t = await setup({ lastSuccessAt: last });
    const f = ownPullFixture();
    const since = new Date(Date.parse(last) - SINCE_MARGIN_MS).toISOString();
    f.data.issues = [
      fakeIssue(PULL_SCOPE.name, 1, { updatedAt: at(50) }),
      fakeIssue(PULL_SCOPE.name, 2, { updatedAt: at(101) }),
    ];
    f.data.pulls = [
      fakePull(1, { updated_at: at(50) }),
      // 前回の成功と同じ秒に更新された PR は、少し戻した起点より後なので取りこぼさない
      fakePull(2, { updated_at: last }),
      fakePull(3, { updated_at: since }),
    ];
    const result = await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher });
    expect(result).toEqual({ outcome: 'success', imported: 3, more: false });
    expect(listCalls(f, 'issues')[0]!.searchParams.get('since')).toBe(since);
    expect((await t.sources()).map((s) => `${s.source_kind}:${s.source_id}`).sort()).toEqual([
      'issue:500002',
      'pull_request:800002',
      'pull_request:800003',
    ]);
    // 取り込み済みの項目は、境界で重なっても二重に入らない
    const again = await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher });
    expect(again).toMatchObject({ outcome: 'success', imported: 0 });
    expect(await t.sources()).toHaveLength(3);
  });

  test('頁の予算で止めた続きは、始めに決めた起点のまま読み、終わった後の同期は新しい起点で始める', async () => {
    const last = at(1000);
    const t = await setup({ lastSuccessAt: last });
    const f = ownPullFixture();
    const since = new Date(Date.parse(last) - SINCE_MARGIN_MS).toISOString();
    f.data.pulls = Array.from({ length: 150 }, (_, i) => fakePull(i + 1, { updated_at: at(2000 + i) }));
    const paused = await syncConnection(env, t.db, t.workspace.id, t.id, {
      fetcher: f.fetcher,
      maxPages: 2,
      source: discoveryOnly,
    });
    expect(paused).toMatchObject({ outcome: 'success', more: true });
    // 途中保存で last_success_at が進んでも、続きは始めの起点で読む
    f.calls.length = 0;
    const done = await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher, source: discoveryOnly });
    expect(done).toMatchObject({ outcome: 'success', more: false });
    expect(listCalls(f, 'issues').every((u) => (u.searchParams.get('since') ?? since) === since)).toBe(true);
    expect((await t.sources()).filter((s) => s.source_kind === 'pull_request')).toHaveLength(150);
  });

  test('複数回の実行にまたがった同期で、読み終えた頁に走査中に作られた項目も、次の同期の差分で拾う', async () => {
    const t = await setup();
    const f = ownPullFixture();
    f.data.pulls = Array.from({ length: 150 }, (_, i) => fakePull(i + 1, { updated_at: at(i + 1) }));
    let now = at(1000);
    const nowFn = () => new Date(now);
    const paused = await syncConnection(env, t.db, t.workspace.id, t.id, {
      fetcher: f.fetcher,
      maxPages: 2,
      now: nowFn,
      source: discoveryOnly,
    });
    expect(paused).toMatchObject({ outcome: 'success', more: true });
    // 読み終えた先頭の頁に、走査中に新しい PR が作られる
    f.data.pulls.push(fakePull(999, { updated_at: at(1002) }));
    now = at(1030);
    const done = await syncConnection(env, t.db, t.workspace.id, t.id, {
      fetcher: f.fetcher,
      now: nowFn,
      source: discoveryOnly,
    });
    expect(done).toMatchObject({ outcome: 'success', more: false });
    // last_success_at は、全部を読み終えた時刻でなく、その同期を始めた時刻
    expect((await t.read())?.last_success_at).toBe(at(1000));
    now = at(1031);
    const next = await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher, now: nowFn });
    expect(next).toMatchObject({ outcome: 'success', imported: 1 });
    expect((await t.sources()).some((s) => s.source_id === '800999')).toBe(true);
  });

  test('除外で持つ接続は、前回の成功があっても起点を付けず全部を読む', async () => {
    const t = await setup({ lastSuccessAt: at(100), scopeMode: 'exclude' });
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 1, { updatedAt: at(1) })];
    await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher, source: allScopes });
    expect(listCalls(f, 'issues').length).toBeGreaterThan(0);
    expect(listCalls(f, 'issues').every((u) => !u.searchParams.has('since'))).toBe(true);
  });

  test('認証情報を替えて捨てた途中の続きの後は、起点を付けず全部を読む', async () => {
    const t = await setup({ lastSuccessAt: at(100) });
    const f = ownPullFixture();
    f.data.pulls = Array.from({ length: 150 }, (_, i) => fakePull(i + 1, { updated_at: at(1 + i) }));
    const paused = await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher, maxPages: 2 });
    expect(paused).toMatchObject({ more: true });
    // 認証情報を替える（指紋が変わる）。続きの状態は残る
    const sealed = await encryptCredential(env, PULL_PAT, t.id);
    await t.db.batch([
      t.db.statement((q) =>
        q
          .updateTable('connections')
          .set({ credential_ciphertext: sealed.ciphertext, credential_key_version: sealed.keyVersion })
          .where('id', '=', t.id),
      ),
    ]);
    f.calls.length = 0;
    await syncConnection(env, t.db, t.workspace.id, t.id, { fetcher: f.fetcher });
    expect(listCalls(f, 'issues')[0]!.searchParams.has('since')).toBe(false);
  });
});
