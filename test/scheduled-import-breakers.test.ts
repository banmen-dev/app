import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { encryptCredential } from '../src/server/crypto/credential.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import worker from '../src/server/index.ts';
import { syncImports } from '../src/server/scheduled/sync-imports.ts';
import {
  createConnection,
  createConnectionScope,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  uuidv7,
} from './factories.ts';
import { createFakePatGithub, fakeIssue, fakePat } from './import/fake-github-pat.ts';

const CURSOR_KEY = 'system/sync-imports-cursor';
const REPO_ID = 4242;
const REPO_NAME = 'guild-fake/cron-breakers';
const SUSPENDED_AT = '2026-01-02T00:00:00.000Z';
const organizations: string[] = [];

async function suspend(ids: string[]) {
  const common = commonDb(env);
  await common.batch([
    common.statement((q) => q.updateTable('organizations').set({ suspended_at: SUSPENDED_AT }).where('id', 'in', ids)),
  ]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (organizations.length > 0) await suspend(organizations.splice(0));
  await env.ATTACHMENTS.delete(CURSOR_KEY);
});

async function setup(issueCount = 1, organizationAt = Date.now()) {
  const organization = await createOrganization({ id: uuidv7(organizationAt) });
  organizations.push(organization.id);
  const user = await createUser(organization);
  const workspace = await createWorkspace(organization, user.id);
  await createMembership(organization, workspace.id, user.id);
  const fake = createFakePatGithub();
  async function addConnection(at: number, lastSuccessAt: string | null = null) {
    const id = uuidv7(at);
    const pat = fakePat(id);
    const encrypted = await encryptCredential(env, pat, id);
    await createConnection(organization, workspace.id, user.id, {
      id,
      credential_ciphertext: encrypted.ciphertext,
      credential_key_version: encrypted.keyVersion,
      credential_last4: pat.slice(-4),
      created_at: new Date(at).toISOString(),
      last_success_at: lastSuccessAt,
    });
    await createConnectionScope(organization, id, { source_id: String(REPO_ID), source_name: REPO_NAME });
    fake.addAccount(pat, { type: 'User', id: 42, login: 'fake-ranger' });
    return { id, pat };
  }
  const { id, pat } = await addConnection(organizationAt);
  fake.addIssues(
    REPO_ID,
    Array.from({ length: issueCount }, (_, index) => fakeIssue(REPO_NAME, index + 1)),
  );
  const db = orgDb(env, organization.verified);
  return {
    organizationId: organization.id,
    fake,
    pat,
    addConnection,
    tasks: () =>
      db.rows(db.statement((q) => q.selectFrom('tasks').select('id').where('workspace_id', '=', workspace.id))),
    connection: () =>
      db.first(
        db.statement((q) =>
          q
            .selectFrom('connections')
            .select('sync_state_json')
            .where('workspace_id', '=', workspace.id)
            .where('id', '=', id),
        ),
      ),
  };
}

function issuePositions(fake: ReturnType<typeof createFakePatGithub>) {
  return fake.calls
    .map(({ url }) => new URL(url))
    .filter((url) => url.pathname === `/repositories/${REPO_ID}/issues`)
    .map((url) => url.searchParams.get('since'));
}

test('接続一覧を読み終えてから同期を始めるまでに組織が停止したら取り込まない', async () => {
  const scope = await setup();
  let suspended = false;
  const target = envWithD1Hooks(env, {
    async afterQuery(sql) {
      if (suspended || !sql.includes('order by "connections"."last_success_at"')) return;
      suspended = true;
      await suspend([scope.organizationId]);
    },
  });

  await syncImports(target, new Date(), { fetcher: scope.fake.fetcher });

  expect(suspended).toBe(true);
  expect(scope.fake.calls).toHaveLength(0);
  expect(await scope.tasks()).toHaveLength(0);
});

test('接続の詳細を読む間に定期処理の60秒が尽きたら取り込み元への新しい要求を始めない', async () => {
  const scope = await setup();
  const startedAt = Date.now();
  let now = startedAt;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let elapsed = false;
  const target = envWithD1Hooks(env, {
    async afterQuery(sql) {
      if (elapsed || !sql.includes('"connections"."credential_ciphertext"')) return;
      elapsed = true;
      now = startedAt + 60_000;
    },
  });

  await syncImports(target, new Date(startedAt), { fetcher: scope.fake.fetcher });

  expect(elapsed).toBe(true);
  expect(scope.fake.calls).toHaveLength(0);
  expect(await scope.tasks()).toHaveLength(0);
});

test('時間切れの時点で開始済みの頁を保存し、次の定期処理で接続の2頁目を読む', async () => {
  const scope = await setup(101);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetcher: typeof fetch = async (input, init) => {
    const response = await scope.fake.fetcher(input, init);
    if (new URL(String(input)).pathname === `/repositories/${REPO_ID}/issues`) now += 60_001;
    return response;
  };

  await syncImports(env, new Date(now), { fetcher });

  expect(issuePositions(scope.fake)).toEqual([null]);
  expect(await scope.tasks()).toHaveLength(100);
  expect((await scope.connection())?.sync_state_json).not.toBe('{}');
  scope.fake.calls.length = 0;
  now += 15 * 60_000;

  await syncImports(env, new Date(now), { fetcher: scope.fake.fetcher });

  const firstPageEnd = fakeIssue(REPO_NAME, 100).updated_at;
  expect(issuePositions(scope.fake)).toEqual([new Date(Date.parse(firstPageEnd) - 1_000).toISOString()]);
  expect(await scope.tasks()).toHaveLength(101);
  // 発見の走査は終わり、残りは取り込み済みの項目を ID で取りに行く段（#1543）。101件は1回の上限（10要求）で終わらない
  expect(JSON.parse((await scope.connection())!.sync_state_json)).toMatchObject({ position: null, known: {} });
});

test('取り込みと掃除の cron の式が同じなら、同じ回で両方が動く', async () => {
  const scope = await setup();
  const db = commonDb(env);
  const state = uuidv7();
  const scheduledTime = Date.now();
  await db.batch([
    db.statement((q) =>
      q.insertInto('oauth_states').values({
        state,
        login_provider: 'github',
        code_verifier: 'fixture',
        expires_at: new Date(scheduledTime - 1_000).toISOString(),
      }),
    ),
  ]);
  vi.stubGlobal('fetch', scope.fake.fetcher);
  const cron = '* * * * *';
  const target = Object.assign({}, env, { IMPORT_SYNC_CRON: cron });

  await worker.scheduled(createScheduledController({ scheduledTime, cron }), target);

  const oauthState = await db.first(
    db.statement((q) => q.selectFrom('oauth_states').select('state').where('state', '=', state)),
  );
  expect(oauthState).toBeUndefined();
  expect(await scope.tasks()).toHaveLength(1);
});

test('巡回開始後に作られた先頭組織の接続は、後続組織の処理に割り込まない', async () => {
  let now = Date.now();
  const first = await setup(1, now - 20_000);
  const later = await setup(1, now - 10_000);
  const existing = await first.addConnection(now - 1_000);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const attempted = new Set<string>();
  const fetcher: typeof fetch = async (input, init) => {
    const pat = new Headers(init?.headers).get('Authorization')!.replace(/^Bearer /, '');
    attempted.add(pat);
    return (pat === later.pat ? later.fake : first.fake).fetcher(input, init);
  };
  const tick = () => syncImports(env, new Date(now), { fetcher, maxConnections: 1 });

  await tick();
  expect([...attempted]).toEqual([first.pat]);

  now += 15 * 60_000;
  const addedDuringSweep = await first.addConnection(now);
  attempted.clear();
  await tick();
  expect([...attempted]).toEqual([existing.pat]);

  now += 15 * 60_000;
  attempted.clear();
  await tick();
  expect([...attempted]).toEqual([later.pat]);
  expect(await later.tasks()).toHaveLength(1);

  now += 15 * 60_000;
  attempted.clear();
  await tick();
  expect([...attempted]).toEqual([addedDuringSweep.pat]);
});

test.each([undefined, '先に保存された進捗'])(
  'R2 の進捗が読み取り時の %s から別の回によって変わったら上書きしない',
  async (initial) => {
    const scope = await setup();
    if (initial !== undefined) await env.ATTACHMENTS.put(CURSOR_KEY, initial);
    const concurrentProgress = '並行した回が保存した進捗';
    let interrupted = false;
    const target = envWithD1Hooks(env, {
      async afterQuery(sql) {
        if (interrupted || !sql.includes('order by "connections"."last_success_at"')) return;
        interrupted = true;
        await env.ATTACHMENTS.put(CURSOR_KEY, concurrentProgress);
      },
    });

    await syncImports(target, new Date(), { fetcher: scope.fake.fetcher });

    expect(interrupted).toBe(true);
    expect(await (await env.ATTACHMENTS.get(CURSOR_KEY))?.text()).toBe(concurrentProgress);
  },
);
