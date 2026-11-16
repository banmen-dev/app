import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb, readReviewTarget, reviewUpdateStatements, readSyncConnection } from '../../src/server/db/index.ts';
import { encryptCredential } from '../../src/server/crypto/credential.ts';
import { syncConnection } from '../../src/server/import/sync.ts';
import {
  ImportSourceError,
  type ImportItem,
  type ImportSource,
  type ReviewRequestPageInput,
  type FetchPageResult,
} from '../../src/server/import/source.ts';
import {
  createConnection,
  createConnectionScope,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  createCompletion,
  createXpGrant,
  createSprint,
  createBoardColumn,
  createSprintEntry,
  createStory,
  uuidv7,
} from '../factories.ts';
const SECRET = 'fake-review-secret';
const AT = '2026-11-17T00:00:00.000Z';
const now = () => new Date(AT);
function item(overrides: Partial<ImportItem> = {}): ImportItem {
  return {
    kind: 'review_request',
    sourceId: '701',
    reviewerSourceId: '1',
    reviewCycle: 'cycle-1',
    key: 'fake/box#1',
    url: 'https://github.com/fake/box/pull/1',
    title: '設計を確認する',
    containerId: '501',
    containerName: 'fake/box',
    status: 'open',
    dueOn: null,
    updatedAt: '2026-11-16T00:00:00.000Z',
    isDone: false,
    ...overrides,
  };
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

function fake() {
  const calls: ReviewRequestPageInput[] = [];
  const state = {
    discovery: [item()] as ImportItem[],
    target: [item()] as ImportItem[],
    failure: null as 'unavailable' | 'forbidden' | null,
    page: null as ((input: ReviewRequestPageInput) => FetchPageResult | Promise<FetchPageResult>) | null,
  };
  const source: ImportSource = {
    kind: 'github',
    scopeKind: 'github_repo',
    parseSettings: () => ({}),
    isCredentialShape: () => true,
    credentialLast4: () => 'fake',
    verifyCredential: async () => ({ kind: 'user', id: '1', name: 'fake' }),
    listScopeCandidates: async () => [],
    fetchPage: async () => ({ items: [], next: null }),
    fetchReviewRequestsPage: async (input) => {
      calls.push(input);
      if (state.page) return state.page(input);
      if (state.failure) throw new ImportSourceError(state.failure, '固定の失敗');
      return { items: input.target ? state.target : state.discovery, next: null };
    },
  };
  return { state, calls, source };
}
async function rows(ctx: Awaited<ReturnType<typeof setup>>) {
  return ctx.db.rows(
    ctx.db.statement((q) => q.selectFrom('tasks').selectAll().where('workspace_id', '=', ctx.workspace.id)),
  );
}
async function sources(ctx: Awaited<ReturnType<typeof setup>>) {
  return ctx.db.rows(
    ctx.db.statement((q) => q.selectFrom('task_sources').selectAll().where('workspace_id', '=', ctx.workspace.id)),
  );
}
async function sync(ctx: Awaited<ReturnType<typeof setup>>, source: ImportSource, maxPages?: number) {
  return syncConnection(env, ctx.db, ctx.workspace.id, ctx.connection.id, { source, now, maxPages });
}
async function moveToBacklog(ctx: Awaited<ReturnType<typeof setup>>, taskId: string) {
  await ctx.db.run(ctx.db.statement((q) => q.updateTable('tasks').set({ tray: 'backlog' }).where('id', '=', taskId)));
}

describe('レビュー依頼の同期と保存', () => {
  test('PR・レビュー依頼・レビュアー違いは別件で、完了済みの新規依頼を作らない', async () => {
    const ctx = await setup();
    const f = fake();
    f.state.discovery = [
      item(),
      item({ reviewerSourceId: '2' }),
      item({ sourceId: '702', isDone: true }),
      item({ reviewCycle: undefined }),
    ];
    f.source.fetchPage = async () => ({
      items: [item({ kind: 'pull_request', reviewerSourceId: '', reviewCycle: undefined })],
      next: null,
    });
    expect(await sync(ctx, f.source)).toMatchObject({ outcome: 'success', imported: 3 });
    expect(await rows(ctx)).toHaveLength(3);
    expect((await sources(ctx)).map((s) => [s.source_kind, s.reviewer_source_id]).sort()).toEqual([
      ['pull_request', ''],
      ['review_request', '1'],
      ['review_request', '2'],
    ]);
    expect(await sync(ctx, f.source)).toMatchObject({ imported: 0 });
    expect(await rows(ctx)).toHaveLength(3);
  });

  test.each(['reviewed', 'closed'])('本人の提出・PR終了(%s)は印だけで、自動完了もXP付与もしない', async (status) => {
    const ctx = await setup();
    const f = fake();
    await sync(ctx, f.source);
    const [before] = await rows(ctx);
    f.state.target = [item({ isDone: true, status, updatedAt: AT })];
    await sync(ctx, f.source);
    expect(await rows(ctx)).toEqual([before]);
    expect(await sources(ctx)).toMatchObject([{ is_source_done: 1, review_cycle: 'cycle-1' }]);
    expect(
      await ctx.db.rows(
        ctx.db.statement((q) => q.selectFrom('completions').selectAll().where('workspace_id', '=', ctx.workspace.id)),
      ),
    ).toEqual([]);
    expect(
      await ctx.db.rows(
        ctx.db.statement((q) => q.selectFrom('xp_grants').selectAll().where('workspace_id', '=', ctx.workspace.id)),
      ),
    ).toEqual([]);
  });

  test('再依頼は同じタスクを1度だけ受信箱へ戻し、完了・経験値を保持する', async () => {
    const ctx = await setup();
    const f = fake();
    await sync(ctx, f.source);
    const [task] = await rows(ctx);
    const sprint = await createSprint(ctx.organization, ctx.workspace.id, {
      status: 'active',
      started_at: AT,
      started_by: ctx.owner.id,
    });
    const column = await createBoardColumn(ctx.organization, ctx.workspace.id);
    const story = await createStory(ctx.organization, ctx.workspace.id, ctx.owner.id);
    const entry = await createSprintEntry(ctx.organization, ctx.workspace.id, sprint.id, task!.id, ctx.owner.id);
    const completion = await createCompletion(ctx.organization, ctx.workspace.id, task!.id, ctx.owner.id);
    const grant = await createXpGrant(ctx.organization, ctx.workspace.id, ctx.owner.id, {
      action: 'task_completed',
      task_id: task!.id,
      completion_id: completion.id,
    });
    await ctx.db.run(
      ctx.db.statement((q) =>
        q
          .updateTable('tasks')
          .set({
            tray: 'backlog',
            completed_at: completion.completed_at,
            completed_by: ctx.owner.id,
            sprint_id: sprint.id,
            column_id: column.id,
            column_position: 'a0',
            story_id: story.id,
            today_on: '2026-11-17',
          })
          .where('id', '=', task!.id),
      ),
    );
    f.state.target = [item({ reviewCycle: 'cycle-2', updatedAt: AT })];
    await Promise.all([sync(ctx, f.source), sync(ctx, f.source)]);
    expect(await rows(ctx)).toMatchObject([
      {
        id: task!.id,
        tray: 'inbox',
        completed_at: null,
        completed_by: null,
        sprint_id: null,
        column_id: null,
        column_position: null,
        story_id: null,
        today_on: null,
      },
    ]);
    expect(
      await ctx.db.first(
        ctx.db.statement((q) => q.selectFrom('sprint_entries').selectAll().where('id', '=', entry.id)),
      ),
    ).toMatchObject({ ended_at: AT, outcome: 'removed' });
    expect(
      await ctx.db.first(
        ctx.db.statement((q) => q.selectFrom('completions').selectAll().where('id', '=', completion.id)),
      ),
    ).toEqual(completion);
    expect(
      await ctx.db.first(ctx.db.statement((q) => q.selectFrom('xp_grants').selectAll().where('id', '=', grant.id))),
    ).toEqual(grant);
    await moveToBacklog(ctx, task!.id);
    await sync(ctx, f.source);
    expect(await rows(ctx)).toMatchObject([{ id: task!.id, tray: 'backlog' }]);
    // 古い回の応答が遅れても復帰させない（同じupdatedAtでも回の記録で拒否）。
    f.state.target = [item({ updatedAt: AT })];
    await sync(ctx, f.source);
    expect(await sources(ctx)).toMatchObject([{ review_cycle: 'cycle-2' }]);
    expect(await rows(ctx)).toMatchObject([{ tray: 'backlog' }]);
  });

  test('未完了でも再依頼は受信箱へ戻す。全走査だけの変化・欠落は反映しない', async () => {
    const ctx = await setup();
    const f = fake();
    await sync(ctx, f.source);
    const [task] = await rows(ctx);
    await moveToBacklog(ctx, task!.id);
    f.state.discovery = [item({ reviewCycle: 'cycle-2', isDone: true, updatedAt: AT })];
    await sync(ctx, f.source);
    expect(await sources(ctx)).toMatchObject([{ is_source_done: 0, review_cycle: 'cycle-1' }]);
    expect(await rows(ctx)).toMatchObject([{ tray: 'backlog' }]);
    f.state.discovery = [];
    f.state.target = [];
    const before = await sources(ctx);
    await sync(ctx, f.source);
    expect(await sources(ctx)).toEqual(before);
    f.state.target = [item({ reviewCycle: 'cycle-2', updatedAt: AT })];
    await sync(ctx, f.source);
    expect(await rows(ctx)).toMatchObject([{ id: task!.id, tray: 'inbox' }]);
  });

  test('target unavailableでは保存状態を保持し、403ではその回を直ちに止める', async () => {
    const ctx = await setup();
    const f = fake();
    await sync(ctx, f.source);
    const before = await sources(ctx);
    f.state.discovery = [];
    f.state.failure = 'unavailable';
    await sync(ctx, f.source);
    expect(await sources(ctx)).toEqual(before);
    f.calls.length = 0;
    f.state.failure = 'forbidden';
    expect(await sync(ctx, f.source)).toMatchObject({ outcome: 'error' });
    expect(f.calls).toHaveLength(1);
    expect(await sources(ctx)).toEqual(before);
  });

  test('読み直しカーソルを保存し、次回同じtargetから再開する', async () => {
    const ctx = await setup();
    const f = fake();
    await sync(ctx, f.source);
    const before = await sources(ctx);
    f.calls.length = 0;
    f.state.page = (input) =>
      input.cursor === null
        ? { items: [], next: 'pull-restarts-0' }
        : { items: [item({ isDone: true, updatedAt: AT })], next: null };
    expect(await sync(ctx, f.source, 1)).toMatchObject({ more: true });
    expect(await sources(ctx)).toEqual(before);
    expect(await sync(ctx, f.source, 1)).toMatchObject({ more: true });
    expect(f.calls[1]).toMatchObject({ cursor: 'pull-restarts-0', target: { sourceId: '701', key: 'fake/box#1' } });
    expect(await sources(ctx)).toMatchObject([{ is_source_done: 1 }]);
  });

  test('取得口の合計を10回で止め、失敗した呼び出しの入力カーソルを保持する', async () => {
    const ctx = await setup();
    const f = fake();
    f.state.page = (input) => ({ items: [], next: String(Number(input.cursor ?? 0) + 1) });
    expect(await sync(ctx, f.source, 100)).toMatchObject({ more: true });
    expect(f.calls).toHaveLength(9); // 通常項目1頁とレビュー9要求
    f.state.page = () => {
      throw new ImportSourceError('forbidden', '失敗');
    };
    expect(await sync(ctx, f.source)).toMatchObject({ outcome: 'error' });
    expect(f.calls.at(-1)?.cursor).toBe('9');
    f.state.page = (input) => ({ items: [], next: String(Number(input.cursor ?? 0) + 1) });
    await sync(ctx, f.source, 1);
    expect(f.calls.at(-1)?.cursor).toBe('9');
  });

  test('認証情報を替えたら本人を含むカーソルを破棄する', async () => {
    const ctx = await setup();
    const f = fake();
    f.state.page = () => ({ items: [], next: 'old-user-cursor' });
    await sync(ctx, f.source, 2);
    const sealed = await encryptCredential(env, 'changed-secret', ctx.connection.id);
    await ctx.db.run(
      ctx.db.statement((q) =>
        q
          .updateTable('connections')
          .set({ credential_ciphertext: sealed.ciphertext, credential_key_version: sealed.keyVersion })
          .where('id', '=', ctx.connection.id),
      ),
    );
    f.calls.length = 0;
    f.state.page = () => ({ items: [], next: null });
    await sync(ctx, f.source);
    expect(f.calls[0]?.cursor).toBeNull();
  });

  test('別組織からはtargetも変更文も届かない', async () => {
    const ctx = await setup();
    const f = fake();
    await sync(ctx, f.source);
    const connection = (await readSyncConnection(ctx.db, ctx.workspace.id, ctx.connection.id))!.connection;
    const target = (await readReviewTarget(ctx.db, connection, '501', ''))!;
    const other = await createOrganization();
    const otherDb = orgDb(env, other.verified);
    expect(await readReviewTarget(otherDb, connection, '501', '')).toBeUndefined();
    await otherDb.batch(
      reviewUpdateStatements(otherDb, connection, target, item({ reviewCycle: 'cycle-2', updatedAt: AT }), 'a1', AT),
    );
    expect(await sources(ctx)).toMatchObject([{ review_cycle: 'cycle-1' }]);
    expect(await syncConnection(env, otherDb, ctx.workspace.id, ctx.connection.id, { source: f.source })).toEqual({
      outcome: 'not_found',
    });
  });
});

test('実通信も10要求以内で止め、取得口の途中を次回に持ち越す', async () => {
  const ctx = await setup();
  const f = fake();
  let requests = 0;
  f.source.fetchPage = async (input) => {
    await input.fetcher('https://fake.example/user');
    await input.fetcher('https://fake.example/issues');
    return { items: [], next: null };
  };
  f.state.page = async (input) => {
    await input.fetcher('https://fake.example/reviews');
    return { items: [], next: String(Number(input.cursor ?? 0) + 1) };
  };
  const fetcher: typeof fetch = async () => {
    requests++;
    return Response.json({});
  };
  expect(
    await syncConnection(env, ctx.db, ctx.workspace.id, ctx.connection.id, { source: f.source, fetcher, now }),
  ).toMatchObject({ more: true });
  expect(requests).toBe(10);
  expect(f.calls).toHaveLength(8);
  f.calls.length = 0;
  requests = 0;
  await syncConnection(env, ctx.db, ctx.workspace.id, ctx.connection.id, {
    source: f.source,
    fetcher,
    now,
    maxPages: 1,
  });
  expect(f.calls[0]?.cursor).toBe('8');
  expect(requests).toBe(1);
});

test('同時刻の照合も版でCASし、停止・認証情報変更後の古い応答を書き込まない', async () => {
  const ctx = await setup();
  const f = fake();
  await sync(ctx, f.source);
  const connection = (await readSyncConnection(ctx.db, ctx.workspace.id, ctx.connection.id))!.connection;
  const old = (await readReviewTarget(ctx.db, connection, '501', ''))!;
  await ctx.db.batch(reviewUpdateStatements(ctx.db, connection, old, item({ isDone: true, updatedAt: AT }), 'a1', AT));
  await ctx.db.batch(reviewUpdateStatements(ctx.db, connection, old, item({ updatedAt: AT }), 'a1', AT));
  expect(await sources(ctx)).toMatchObject([{ is_source_done: 1 }]);
  const target = (await readReviewTarget(ctx.db, connection, '501', ''))!;
  await ctx.db.run(
    ctx.db.statement((q) =>
      q.updateTable('connections').set({ status: 'stopped', stopped_reason: 'owner' }).where('id', '=', connection.id),
    ),
  );
  await ctx.db.batch(
    reviewUpdateStatements(ctx.db, connection, target, item({ reviewCycle: 'cycle-2', updatedAt: AT }), 'a1', AT),
  );
  expect(await sources(ctx)).toMatchObject([{ review_cycle: 'cycle-1' }]);
  const sealed = await encryptCredential(env, 'changed-while-syncing', connection.id);
  await ctx.db.run(
    ctx.db.statement((q) =>
      q
        .updateTable('connections')
        .set({ status: 'active', stopped_reason: null, credential_ciphertext: sealed.ciphertext })
        .where('id', '=', connection.id),
    ),
  );
  await ctx.db.batch(
    reviewUpdateStatements(ctx.db, connection, target, item({ reviewCycle: 'cycle-2', updatedAt: AT }), 'a1', AT),
  );
  expect(await sources(ctx)).toMatchObject([{ review_cycle: 'cycle-1' }]);
});

test('GitHub取得口を実際に同期へ接続し、依頼・本人提出・再依頼を保存する', async () => {
  const { importSourceOf } = await import('../../src/server/import/index.ts');
  const { fakePat } = await import('./fake-github-pat.ts');
  const ctx = await setup();
  const credential = fakePat('SyncReview');
  const sealed = await encryptCredential(env, credential, ctx.connection.id);
  await ctx.db.run(
    ctx.db.statement((q) =>
      q
        .updateTable('connections')
        .set({ credential_ciphertext: sealed.ciphertext })
        .where('id', '=', ctx.connection.id),
    ),
  );
  const data = { cycle: 101, reviewed: false, updatedAt: '2026-11-16T10:00:00Z' };
  const pull = () => ({
    id: 701,
    number: 1,
    title: '架空のレビュー',
    html_url: 'https://github.com/fake/box/pull/1',
    state: 'open',
    updated_at: data.updatedAt,
    requested_reviewers: data.reviewed ? [] : [{ id: 42 }],
  });
  let requests = 0;
  let failure = 0;
  const fetcher: typeof fetch = async (input) => {
    requests++;
    const url = new URL(String(input));
    if (failure && url.pathname.endsWith('/timeline')) return new Response('', { status: failure });
    if (url.pathname === '/user') return Response.json({ type: 'User', id: 42, login: 'fake-ranger' });
    if (url.pathname.endsWith('/issues')) return Response.json([]);
    if (url.pathname.endsWith('/pulls')) return Response.json(url.searchParams.get('page') === '1' ? [pull()] : []);
    if (url.pathname.endsWith('/timeline'))
      return Response.json([
        { event: 'review_requested', id: data.cycle, requested_reviewer: { id: 42 } },
        ...(data.reviewed
          ? [{ event: 'reviewed', id: 201, user: { id: 42 }, state: 'approved', submitted_at: data.updatedAt }]
          : []),
      ]);
    if (url.pathname.endsWith('/pulls/1')) return Response.json(pull());
    throw new Error('想定していない要求');
  };
  const source = importSourceOf('github');
  async function drain() {
    for (let i = 0; i < 12; i++) {
      requests = 0;
      const result = await syncConnection(env, ctx.db, ctx.workspace.id, ctx.connection.id, { source, fetcher, now });
      expect(requests).toBeLessThanOrEqual(10);
      expect(result.outcome).toBe('success');
      if (result.outcome === 'success' && !result.more) return;
    }
    throw new Error('同期が終了しない');
  }
  await drain();
  expect(await sources(ctx)).toMatchObject([{ review_cycle: '101', is_source_done: 0 }]);
  const [task] = await rows(ctx);
  await moveToBacklog(ctx, task!.id);
  data.reviewed = true;
  data.updatedAt = '2026-11-16T11:00:00Z';
  await drain();
  expect(await sources(ctx)).toMatchObject([{ review_cycle: '101', is_source_done: 1 }]);
  expect(await rows(ctx)).toMatchObject([{ id: task!.id, completed_at: null, tray: 'backlog' }]);
  data.reviewed = false;
  data.cycle = 301;
  data.updatedAt = '2026-11-16T12:00:00Z';
  await drain();
  expect(await sources(ctx)).toMatchObject([{ review_cycle: '301', is_source_done: 0 }]);
  expect(await rows(ctx)).toMatchObject([{ id: task!.id, completed_at: null, tray: 'inbox' }]);
  // 実際の403/429でもその回を止め、保存状態を動かさない。
  for (const status of [403, 429]) {
    failure = status;
    requests = 0;
    const before = await sources(ctx);
    expect(
      await syncConnection(env, ctx.db, ctx.workspace.id, ctx.connection.id, { source, fetcher, now }),
    ).toMatchObject({ outcome: 'error' });
    expect(requests).toBeLessThanOrEqual(10);
    expect(await sources(ctx)).toEqual(before);
  }
});

test.each([true, false])('再依頼が同期前に提出・終了済みでも既存タスクを復帰する（isDone=%s）', async (isDone) => {
  const ctx = await setup();
  const f = fake();
  await sync(ctx, f.source);
  const [task] = await rows(ctx);
  await ctx.db.run(
    ctx.db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ tray: 'backlog', completed_at: AT, completed_by: ctx.owner.id })
        .where('id', '=', task!.id),
    ),
  );
  f.state.target = [item({ reviewCycle: 'cycle-2', updatedAt: AT, isDone })];
  await sync(ctx, f.source);
  expect(await sources(ctx)).toMatchObject([{ review_cycle: 'cycle-2', is_source_done: isDone ? 1 : 0 }]);
  expect(await rows(ctx)).toMatchObject([{ id: task!.id, tray: 'inbox', completed_at: null }]);
  await moveToBacklog(ctx, task!.id);
  await sync(ctx, f.source);
  expect(await rows(ctx)).toMatchObject([{ tray: 'backlog' }]);
});

test.each(['delete', 'revision'])('照合途中で対象の%sが変われば古い履歴カーソルを使わない', async (change) => {
  const ctx = await setup();
  const f = fake();
  f.state.discovery = [item(), item({ sourceId: '702', key: 'fake/box#2' })];
  await sync(ctx, f.source);
  const before = await sources(ctx);
  f.state.page = () => ({ items: [], next: 'old-target-history' });
  await sync(ctx, f.source, 1);
  const targetId = (await readReviewTarget(
    ctx.db,
    (await readSyncConnection(ctx.db, ctx.workspace.id, ctx.connection.id))!.connection,
    '501',
    '',
  ))!.task_id;
  if (change === 'delete') {
    await ctx.db.run(
      ctx.db.statement((q) => q.updateTable('tasks').set({ deleted_at: AT }).where('id', '=', targetId)),
    );
  } else {
    await ctx.db.run(
      ctx.db.statement((q) =>
        q
          .updateTable('task_sources')
          .set({ review_revision: 9, review_cycle: 'newer-cycle' })
          .where('task_id', '=', targetId),
      ),
    );
  }
  f.calls.length = 0;
  f.state.page = () => ({ items: [], next: null });
  await sync(ctx, f.source, 1);
  expect(f.calls[0]?.cursor).toBeNull();
  expect(f.calls[0]?.target?.sourceId).toBe(
    change === 'delete'
      ? before.find((s) => s.task_id !== targetId)!.source_id
      : before.find((s) => s.task_id === targetId)!.source_id,
  );
});

test('取得中にPATを替えたら旧本人の新規依頼も保存しない', async () => {
  const ctx = await setup();
  const f = fake();
  f.state.page = async () => {
    const sealed = await encryptCredential(env, 'another-owner', ctx.connection.id);
    await ctx.db.run(
      ctx.db.statement((q) =>
        q
          .updateTable('connections')
          .set({ credential_ciphertext: sealed.ciphertext })
          .where('id', '=', ctx.connection.id),
      ),
    );
    return { items: [item()], next: null };
  };
  expect(await sync(ctx, f.source)).toEqual({ outcome: 'stopped' });
  expect(await rows(ctx)).toEqual([]);
  expect(await sources(ctx)).toEqual([]);
});

test('除外モードは候補一覧が10頁を超えても列挙位置と現在頁を保持し取り込みに到達する', async () => {
  const ctx = await setup();
  const f = fake();
  const candidates: (string | null)[] = [];
  await ctx.db.run(
    ctx.db.statement((q) =>
      q.updateTable('connections').set({ scope_mode: 'exclude' }).where('id', '=', ctx.connection.id),
    ),
  );
  f.source.fetchScopeCandidatesPage = async (input) => {
    candidates.push(input.cursor);
    await input.fetcher('https://fake.example/candidates');
    const n = Number(input.cursor ?? 1);
    return n <= 12
      ? { candidates: [{ id: '501', name: 'fake/box' }], next: String(n + 1) }
      : { candidates: [{ id: '502', name: 'fake/new' }], next: null };
  };
  f.state.discovery = [item({ containerId: '502', containerName: 'fake/new' })];
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return Response.json({});
  };
  const options = { source: f.source, fetcher, now };
  expect(await syncConnection(env, ctx.db, ctx.workspace.id, ctx.connection.id, options)).toMatchObject({ more: true });
  expect(candidates).toHaveLength(10);
  expect(requests).toBe(10);
  requests = 0;
  expect(await syncConnection(env, ctx.db, ctx.workspace.id, ctx.connection.id, options)).toMatchObject({
    more: false,
    imported: 1,
  });
  expect(candidates[10]).toBe('11');
  expect(requests).toBeLessThanOrEqual(10);
  expect(await rows(ctx)).toHaveLength(1);
});
