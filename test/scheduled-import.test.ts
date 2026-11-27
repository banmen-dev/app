import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
import { FAKE_FAILURE_MARK, createFakePatGithub, fakeIssue, fakePat } from './import/fake-github-pat.ts';

const DEFAULT_CRON = '*/15 * * * *';
const CURSOR = 'system/sync-imports-cursor';
const OLDER = '2026-01-01T00:00:00.000Z';
const NEWER = '2026-01-02T00:00:00.000Z';
const organizationIds: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const db = commonDb(env);
  if (organizationIds.length > 0) {
    await db.batch([
      db.statement((q) =>
        q.updateTable('organizations').set({ suspended_at: NEWER }).where('id', 'in', organizationIds),
      ),
    ]);
    organizationIds.length = 0;
  }
  await env.ATTACHMENTS.delete(CURSOR);
});

type ConnectionOverrides = NonNullable<Parameters<typeof createConnection>[3]>;

async function setup(options: { suspended?: boolean; closed?: boolean } = {}) {
  const organization = await createOrganization({
    id: uuidv7(Date.parse(NEWER) + organizationIds.length),
    ...(options.suspended ? { suspended_at: NEWER } : {}),
  });
  organizationIds.push(organization.id);
  const owner = await createUser(organization);
  const workspace = await createWorkspace(organization, owner.id, options.closed ? { closed_at: NEWER } : {});
  await createMembership(organization, workspace.id, owner.id);
  const db = orgDb(env, organization.verified);

  return {
    owner,
    workspace,
    async connection(repo: number, options: ConnectionOverrides = {}) {
      const id = uuidv7();
      const pat = fakePat(id);
      const encrypted = await encryptCredential(env, pat, id);
      const connection = await createConnection(organization, workspace.id, owner.id, {
        id,
        ...(options.deleted_at
          ? {}
          : {
              credential_ciphertext: encrypted.ciphertext,
              credential_key_version: encrypted.keyVersion,
              credential_last4: pat.slice(-4),
            }),
        ...options,
      });
      await createConnectionScope(organization, id, { source_id: String(repo), source_name: repoName(repo) });
      return { ...connection, pat };
    },
    async readConnection(id: string) {
      return db.first(
        db.statement((q) =>
          q
            .selectFrom('connections')
            .select(['status', 'stopped_reason', 'last_success_at', 'last_error_message', 'consecutive_failures'])
            .where('workspace_id', '=', workspace.id)
            .where('id', '=', id),
        ),
      );
    },
    async tasks() {
      return db.rows(
        db.statement((q) =>
          q
            .selectFrom('tasks')
            .select(['title', 'tray', 'assignee_user_id'])
            .where('workspace_id', '=', workspace.id)
            .orderBy('title'),
        ),
      );
    },
  };
}

const repoName = (repo: number) => `guild-fake/scheduled-${repo}`;

function github() {
  const fake = createFakePatGithub();
  return {
    ...fake,
    add(pat: string, repo: number, title = `担当の課題 ${repo}`) {
      fake.addAccount(pat, { type: 'User', id: 42, login: 'fake-ranger' });
      fake.addIssues(repo, [fakeIssue(repoName(repo), repo, { title })]);
    },
    attemptedPats() {
      return [...new Set(fake.calls.map((call) => call.headers['authorization']?.replace(/^Bearer /, '')))];
    },
  };
}

function tick(cron: string, target: Env = env) {
  return worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron }), target);
}

describe('取り込みの定期処理', () => {
  test('設定した cron から GitHub の担当項目が受信箱に届き、対象外の接続は同期しない', async () => {
    const active = await setup();
    const closed = await setup({ closed: true });
    const suspended = await setup({ suspended: true });
    const fake = github();
    const connection = await active.connection(1101);
    const stopped = await active.connection(1102, { status: 'stopped', stopped_reason: 'owner' });
    const deleted = await active.connection(1103, { deleted_at: NEWER });
    const inClosed = await closed.connection(1104);
    const inSuspended = await suspended.connection(1105);
    fake.add(connection.pat, 1101);
    fake.add(stopped.pat, 1102);
    fake.add(deleted.pat, 1103);
    fake.add(inClosed.pat, 1104);
    fake.add(inSuspended.pat, 1105);
    fake.addIssues(1101, [
      fakeIssue(repoName(1101), 1, { title: '新しく担当になった課題' }),
      fakeIssue(repoName(1101), 2, { title: '他の人の課題', assignees: ['fake-other'] }),
    ]);
    vi.stubGlobal('fetch', fake.fetcher);

    await tick(env.IMPORT_SYNC_CRON);

    expect(fake.attemptedPats()).toEqual([connection.pat]);
    expect(await active.tasks()).toEqual([
      { title: '新しく担当になった課題', tray: 'inbox', assignee_user_id: active.owner.id },
    ]);
    expect(await closed.tasks()).toEqual([]);
    expect(await suspended.tasks()).toEqual([]);
    expect(await active.readConnection(connection.id)).toMatchObject({ last_success_at: expect.any(String) });
    expect(await active.readConnection(stopped.id)).toMatchObject({ status: 'stopped', last_success_at: null });
    expect(await active.readConnection(deleted.id)).toMatchObject({ last_success_at: null });
  });

  test('vars の式で取り込みを実行し、既定の式は表から外れる', async () => {
    const scope = await setup();
    const connection = await scope.connection(1201);
    const fake = github();
    fake.add(connection.pat, 1201);
    vi.stubGlobal('fetch', fake.fetcher);
    const cron = '*/7 * * * *';
    const target = Object.assign({}, env, { IMPORT_SYNC_CRON: cron });

    await expect(tick(DEFAULT_CRON, target)).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
    await tick(cron, target);

    expect(fake.attemptedPats()).toEqual([connection.pat]);
    expect(await scope.tasks()).toHaveLength(1);
  });

  test('未成功を先に古い順で処理し、件数上限の次の回は失敗した先頭を飛ばして残りへ進む', async () => {
    const scope = await setup();
    const newest = await scope.connection(1303, { last_success_at: NEWER });
    const oldest = await scope.connection(1302, { last_success_at: OLDER });
    const never = await scope.connection(1301);
    const fake = github();
    fake.add(never.pat, 1301);
    fake.add(oldest.pat, 1302);
    fake.add(newest.pat, 1303);
    fake.failNext({ kind: 'status', status: 503 });
    const options = { maxConnections: 2, fetcher: fake.fetcher };

    await syncImports(env, new Date(), options);

    expect(fake.attemptedPats()).toEqual([never.pat, oldest.pat]);
    expect(await scope.readConnection(never.id)).toMatchObject({ status: 'error', last_success_at: null });
    expect(await scope.readConnection(newest.id)).toMatchObject({ last_success_at: NEWER });
    fake.calls.length = 0;

    await syncImports(env, new Date(Date.now() + 15 * 60_000), options);

    expect(fake.attemptedPats()[0]).toBe(newest.pat);
    expect(await scope.readConnection(newest.id)).toMatchObject({ status: 'active' });
    expect(await scope.tasks()).toEqual([
      { title: '担当の課題 1302', tray: 'inbox', assignee_user_id: scope.owner.id },
      { title: '担当の課題 1303', tray: 'inbox', assignee_user_id: scope.owner.id },
    ]);
  });

  test('時間予算を使い切った接続の後ろは次の回に処理する', async () => {
    const scope = await setup();
    const first = await scope.connection(1401);
    const second = await scope.connection(1402, { last_success_at: OLDER });
    const fake = github();
    fake.add(first.pat, 1401);
    fake.add(second.pat, 1402);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher: typeof fetch = async (input, init) => {
      now += 10_001;
      return fake.fetcher(input, init);
    };

    await syncImports(env, new Date(now), { timeBudgetMs: 10_000, fetcher });

    expect(fake.attemptedPats()).toEqual([first.pat]);
    expect(await scope.readConnection(second.id)).toMatchObject({ last_success_at: OLDER });
    fake.calls.length = 0;
    now += 15 * 60_000;

    await syncImports(env, new Date(now), { fetcher: fake.fetcher });

    expect(fake.attemptedPats()[0]).toBe(second.pat);
    expect(await scope.tasks()).toContainEqual({
      title: '担当の課題 1402',
      tray: 'inbox',
      assignee_user_id: scope.owner.id,
    });
  });

  test('失効した PAT は止め、一時エラーは再試行し、ログへ応答と認証情報を出さない', async () => {
    const scope = await setup();
    const expired = await scope.connection(1501);
    const transient = await scope.connection(1502, { last_success_at: OLDER });
    const active = await scope.connection(1503, { last_success_at: NEWER });
    const fake = github();
    fake.add(transient.pat, 1502);
    fake.add(active.pat, 1503);
    let interrupted = false;
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!interrupted && request.headers.get('authorization') === `Bearer ${transient.pat}`) {
        interrupted = true;
        fake.failNext({ kind: 'status', status: 503, body: `${FAKE_FAILURE_MARK} ${transient.pat}` });
      }
      return fake.fetcher(input, init);
    };
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    for (const log of logs) log.mockImplementation(() => undefined);

    await syncImports(env, new Date(), { fetcher });

    expect(fake.attemptedPats()).toEqual([expired.pat, transient.pat, active.pat]);
    expect(await scope.readConnection(expired.id)).toMatchObject({ status: 'stopped', stopped_reason: 'auth_failed' });
    expect(await scope.readConnection(transient.id)).toMatchObject({
      status: 'error',
      stopped_reason: null,
      consecutive_failures: 1,
    });
    expect(await scope.tasks()).toHaveLength(1);
    fake.calls.length = 0;

    await syncImports(env, new Date(Date.now() + 15 * 60_000), { fetcher });

    expect(fake.attemptedPats()).toContain(transient.pat);
    expect(fake.attemptedPats()).not.toContain(expired.pat);
    expect(await scope.readConnection(transient.id)).toMatchObject({ status: 'active', consecutive_failures: 0 });
    expect(await scope.tasks()).toHaveLength(2);
    const output = JSON.stringify(logs.flatMap((log) => log.mock.calls));
    expect(output).not.toContain(FAKE_FAILURE_MARK);
    expect(output).not.toContain(transient.pat);
    expect(output).not.toContain(expired.pat);
  });

  test('ある組織の接続一覧が読めなくても、次の組織を同期する', async () => {
    const broken = await setup();
    const healthy = await setup();
    const skipped = await broken.connection(1601);
    const synced = await healthy.connection(1602);
    const fake = github();
    fake.add(skipped.pat, 1601);
    fake.add(synced.pat, 1602);
    let intercepted = false;
    const target = envWithD1Hooks(env, {
      async afterQuery(sql) {
        if (intercepted || !/\bfrom "connections"/.test(sql)) return;
        intercepted = true;
        throw new Error(FAKE_FAILURE_MARK);
      },
    });

    await expect(syncImports(target, new Date(), { fetcher: fake.fetcher })).rejects.toThrow();

    expect(intercepted).toBe(true);
    expect(fake.attemptedPats()).toEqual([synced.pat]);
    expect(await broken.tasks()).toEqual([]);
    expect(await healthy.tasks()).toHaveLength(1);
  });
});
