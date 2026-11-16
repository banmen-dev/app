// 組織ごとの読み取りが選択順と逆に完了しても、内容・失敗・ログを別の組織へ付け替えない。
import { afterEach, expect, test, vi } from 'vitest';
import { readAccountTaskOrganizations } from '../src/server/db/index.ts';
import { createOrganization, createUser } from './factories.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

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

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

const reference = (target: Awaited<ReturnType<typeof targetFor>>) => ({
  slug: target.organization.slug,
  name: target.organization.name,
  kind: target.organization.kind,
});

test('最後の組織から先に完了しても、成功内容と失敗の診断を名前順の正しい組織へ結ぶ', async () => {
  const person = await createPerson();
  // 作成順も名前順と変える。全ての値が同じでも偶然に通る期待値にはしない。
  const last = await targetFor(person, 'う先に読める工房');
  const first = await targetFor(person, 'あ遅れて読める工房');
  const failed = await targetFor(person, 'い途中で失敗する工房');
  type Content = { organizationId: string; userId: string };
  const firstGate = gate<Content>();
  const failedGate = gate<Content>();
  const lastGate = gate<Content>();
  const started = gate<void>();
  const ready = new Map([
    [first.organization.id, firstGate],
    [failed.organization.id, failedGate],
    [last.organization.id, lastGate],
  ]);
  const entered: Content[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const pending = readAccountTaskOrganizations(
    testEnv,
    { accountId: person.accountId, logins: [person.login], authenticatedAt: new Date().toISOString() },
    async (db, userId) => {
      entered.push({ organizationId: db.organizationId, userId });
      if (entered.length === 3) started.resolve();
      return ready.get(db.organizationId)!.promise;
    },
  );
  await started.promise;
  expect(entered).toEqual(
    expect.arrayContaining([
      { organizationId: first.organization.id, userId: first.user.id },
      { organizationId: failed.organization.id, userId: failed.user.id },
      { organizationId: last.organization.id, userId: last.user.id },
    ]),
  );
  lastGate.resolve({ organizationId: last.organization.id, userId: last.user.id });
  failedGate.reject(new TypeError('架空の本文や認証情報は記録しない'));
  firstGate.resolve({ organizationId: first.organization.id, userId: first.user.id });
  expect(await pending).toEqual({
    organizations: [
      { organization: reference(first), data: { organizationId: first.organization.id, userId: first.user.id } },
      { organization: reference(last), data: { organizationId: last.organization.id, userId: last.user.id } },
    ],
    failed_organizations: [reference(failed)],
    omitted_organizations: 0,
  });
  expect(log.mock.calls).toHaveLength(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
    error: 'TypeError',
    organizationId: failed.organization.id,
  });
});
