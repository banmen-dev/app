import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { encryptCredential } from '../src/server/crypto/credential.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
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
import { createFakePatGithub, fakeIssue, fakePat, fakeRepos } from './import/fake-github-pat.ts';

const CURSOR = 'system/sync-imports-cursor';
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const LAST_SUCCESS_AT = '2026-11-02T00:00:00.000Z';
const repo = fakeRepos(1)[0]!;
const organizationIds: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (organizationIds.length > 0) {
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ suspended_at: LAST_SUCCESS_AT })
          .where('id', 'in', organizationIds.splice(0)),
      ),
    ]);
  }
  await env.ATTACHMENTS.delete(CURSOR);
});

async function addOrganization(id?: string) {
  const organization = await createOrganization({ id: id ?? uuidv7(Date.parse(CREATED_AT)), created_at: CREATED_AT });
  organizationIds.push(organization.id);
  return organization;
}

async function setup(organization = undefined as Awaited<ReturnType<typeof addOrganization>> | undefined) {
  organization ??= await addOrganization();
  const owner = await createUser(organization);
  const workspace = await createWorkspace(organization, owner.id);
  await createMembership(organization, workspace.id, owner.id);
  const db = orgDb(env, organization.verified);
  const fake = createFakePatGithub();
  fake.addIssues(repo.id, [fakeIssue(repo.full_name, 1, { title: '同期対象の課題' })]);
  return {
    fake,
    async addConnection(options: {
      owner?: 'disabled' | 'left';
      mode?: 'include' | 'exclude';
      scope: boolean;
      lastSuccessAt?: string;
    }) {
      let connectionOwner = owner;
      if (options.owner !== undefined) {
        const disabled = options.owner === 'disabled';
        connectionOwner = await createUser(organization, disabled ? { disabled_at: LAST_SUCCESS_AT } : {});
        await createMembership(
          organization,
          workspace.id,
          connectionOwner.id,
          disabled ? {} : { left_at: LAST_SUCCESS_AT, left_on: LAST_SUCCESS_AT.slice(0, 10) },
        );
      }
      const id = uuidv7();
      const pat = fakePat(id);
      const credential = await encryptCredential(env, pat, id);
      await createConnection(organization, workspace.id, connectionOwner.id, {
        id,
        scope_mode: options.mode ?? 'include',
        credential_ciphertext: credential.ciphertext,
        credential_key_version: credential.keyVersion,
        credential_last4: pat.slice(-4),
        created_at: CREATED_AT,
        last_success_at: options.lastSuccessAt ?? null,
      });
      if (options.scope) {
        await createConnectionScope(organization, id, { source_id: String(repo.id), source_name: repo.full_name });
      }
      fake.addAccount(pat, { type: 'User', id: 42, login: 'fake-ranger' }, [repo]);
      return pat;
    },
    async tasks() {
      return db.rows(
        db.statement((q) => q.selectFrom('tasks').select(['title', 'tray']).where('workspace_id', '=', workspace.id)),
      );
    },
  };
}

const PENDING_IMPORT = { title: '同期対象の課題', tray: 'inbox' };

test.each([
  { name: '対象範囲が空の include', options: { scope: false } },
  { name: '無効にした登録者', options: { scope: true, owner: 'disabled' } },
  { name: 'ワークスペースを離れた登録者', options: { scope: true, owner: 'left' } },
] as const)('$name の接続が古くても有効な接続に件数枠を使う', async ({ options }) => {
  const scope = await setup();
  await scope.addConnection(options);
  const healthy = await scope.addConnection({ scope: true, lastSuccessAt: LAST_SUCCESS_AT });

  await syncImports(env, new Date(), { fetcher: scope.fake.fetcher, maxConnections: 1 });

  expect(await scope.tasks()).toEqual([PENDING_IMPORT]);
  expect(new Set(scope.fake.calls.map((call) => call.headers.authorization))).toEqual(new Set([`Bearer ${healthy}`]));
});

test('除外範囲が空の exclude では取り込みを続ける', async () => {
  const scope = await setup();
  await scope.addConnection({ mode: 'exclude', scope: false });

  await syncImports(env, new Date(), { fetcher: scope.fake.fetcher, maxConnections: 1 });

  expect(await scope.tasks()).toEqual([PENDING_IMPORT]);
});

test('壊れた進捗は読み飛ばして先頭から同期する', async () => {
  const scope = await setup();
  await scope.addConnection({ scope: true });
  await env.ATTACHMENTS.put(CURSOR, '{"position":');

  await syncImports(env, new Date(), { fetcher: scope.fake.fetcher });

  expect(await scope.tasks()).toEqual([PENDING_IMPORT]);
  expect(await (await env.ATTACHMENTS.get(CURSOR))?.json()).toMatchObject({ position: null });
});

test('接続がない組織も含め50組織で巡回を区切り、次の回に51番目の組織を同期する', async () => {
  const started = Date.parse(CREATED_AT);
  for (let index = 0; index < 49; index++) {
    await addOrganization(uuidv7(started + index));
  }
  const fiftieth = await addOrganization(uuidv7(started + 49));
  const scope = await setup(await addOrganization(uuidv7(started + 50)));
  await scope.addConnection({ scope: true });
  const options = { fetcher: scope.fake.fetcher };

  await syncImports(env, new Date(), options);
  expect(scope.fake.calls).toHaveLength(0);
  expect(await scope.tasks()).toHaveLength(0);
  expect(await (await env.ATTACHMENTS.get(CURSOR))?.json()).toMatchObject({
    position: { organizationId: fiftieth.id, connection: null },
  });

  await syncImports(env, new Date(), options);
  expect(await scope.tasks()).toEqual([PENDING_IMPORT]);
});

test('組織の一覧が読めなければ外部取得も進捗の上書きも始めない', async () => {
  const scope = await setup();
  await scope.addConnection({ scope: true });
  const previous = JSON.stringify({ position: null });
  await env.ATTACHMENTS.put(CURSOR, previous);
  const cause = '共通 DB のテスト用の内部情報';
  const target = envWithD1Hooks(env, {
    async afterQuery(sql) {
      if (sql.includes('from "organizations"') && sql.includes('order by "id"')) throw new Error(cause);
    },
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  await expect(syncImports(target, new Date(), { fetcher: scope.fake.fetcher })).rejects.toThrow(
    '取り込みの定期処理に失敗した',
  );

  expect(scope.fake.calls).toHaveLength(0);
  expect(await (await env.ATTACHMENTS.get(CURSOR))?.text()).toBe(previous);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('"organization_list":1'));
  expect(error).not.toHaveBeenCalledWith(expect.stringContaining(cause));
});

test('進捗の保存が失敗した回で取り込んだタスクを、次の回で重ねて作らない', async () => {
  const scope = await setup();
  await scope.addConnection({ scope: true });
  const cause = 'R2 のテスト用の内部情報';
  const ATTACHMENTS = new Proxy(env.ATTACHMENTS, {
    get(bucket, key) {
      if (key === 'put') {
        return async () => {
          throw new Error(cause);
        };
      }
      const binding = Reflect.get(bucket, key);
      return typeof binding === 'function' ? binding.bind(bucket) : binding;
    },
  });
  const target = Object.assign({}, env, { ATTACHMENTS });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const options = { fetcher: scope.fake.fetcher };

  await expect(syncImports(target, new Date(), options)).rejects.toThrow('取り込みの定期処理に失敗した');
  expect(await scope.tasks()).toEqual([PENDING_IMPORT]);
  expect(await env.ATTACHMENTS.get(CURSOR)).toBeNull();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('"cursor_write":1'));
  expect(error).not.toHaveBeenCalledWith(expect.stringContaining(cause));

  await syncImports(env, new Date(), options);
  expect(await scope.tasks()).toEqual([PENDING_IMPORT]);
  expect(await env.ATTACHMENTS.get(CURSOR)).not.toBeNull();
});
