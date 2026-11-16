// 想定外の投げ値を観測するときも、1組織の失敗をほかへ広げず秘密を記録しない。
import { afterEach, expect, test, vi } from 'vitest';
import { readAccountTaskOrganizations } from '../src/server/db/index.ts';
import { createOrganization, createUser } from './factories.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const SECRET = '架空の認証情報と本文を含む例外';
afterEach(() => vi.restoreAllMocks());

async function targetFor(person: Person, name: string) {
  const organization = await createOrganization({ name });
  const user = await createUser(organization, {
    account_id: person.accountId,
    login_provider: person.login.provider,
    login_subject: person.login.subject,
    is_admin: 1,
  });
  return { organization, user };
}

const ref = (target: Awaited<ReturnType<typeof targetFor>>) => ({
  slug: target.organization.slug,
  name: target.organization.name,
  kind: target.organization.kind,
});

async function readFailure(failure: unknown) {
  const person = await createPerson();
  const failed = await targetFor(person, 'あ失敗する工房');
  const ordinary = await targetFor(person, 'い読める工房');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await readAccountTaskOrganizations(
    testEnv,
    { accountId: person.accountId, logins: [person.login], authenticatedAt: new Date().toISOString() },
    async (db) => {
      if (db.organizationId === failed.organization.id) throw failure;
      return '表示する仕事';
    },
  );
  expect(result.organizations).toEqual([{ organization: ref(ordinary), data: '表示する仕事' }]);
  expect(result.failed_organizations).toEqual([ref(failed)]);
  expect(error.mock.calls).toHaveLength(1);
  expect(JSON.parse(error.mock.calls[0]![0] as string)).toEqual({
    error: 'UnknownError',
    organizationId: failed.organization.id,
  });
  expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET);
}

test('nameやmessageのgetterを評価せず安全な分類だけ記録する', async () => {
  const accessed = vi.fn(() => {
    throw new Error(SECRET);
  });
  const failure = new Error();
  Object.defineProperties(failure, {
    name: { get: accessed },
    message: { get: accessed },
  });
  await readFailure(failure);
  expect(accessed).not.toHaveBeenCalled();
});

test('nameのプロパティ記述子の取得が投げても、分類の失敗を外へ広げない', async () => {
  const failure = new Proxy(new Error(SECRET), {
    getOwnPropertyDescriptor() {
      throw new Error(SECRET);
    },
  });
  await readFailure(failure);
});

test('取り消されたProxyを投げても、その組織だけを失敗にする', async () => {
  const failure = Proxy.revocable({}, {});
  failure.revoke();
  await readFailure(failure.proxy);
});
