// PR #1322 の点検指摘: 組織をまたぐ読み取りは認可済みの入口だけに渡し、想定外の失敗を安全に記録する。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readAccountTaskOrganizations } from '../src/server/db/index.ts';
import { ApiError } from '../src/server/errors.ts';
import { createMembership, createOrganization, createUser, createWorkspace } from './factories.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const NOW = '2026-11-02T03:00:00.000Z';
const SECRET = '本文_タスクの題_認証情報_bnp_架空の秘密';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function organizationFor(person: Person, name: string, credentialsNotBefore: string | null = null) {
  const organization = await createOrganization({ name });
  const user = await createUser(organization, {
    account_id: person.accountId,
    login_provider: person.login.provider,
    login_subject: person.login.subject,
    credentials_not_before: credentialsNotBefore,
    is_admin: 1,
  });
  const workspace = await createWorkspace(organization, user.id);
  await createMembership(organization, workspace.id, user.id);
  return { organization, user };
}

function reference(target: Awaited<ReturnType<typeof organizationFor>>) {
  const { slug, name, kind } = target.organization;
  return { slug, name, kind };
}

const accountOf = (person: Person) => ({ accountId: person.accountId, logins: [person.login], authenticatedAt: NOW });

// ログは安全に分類した種類と組織のIDの2フィールドだけにする。
function expectSafeLog(calls: unknown[][], organizationId: string, kind: string) {
  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(1);
  const raw = calls[0]![0];
  const record = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  expect(record).toBeTypeOf('object');
  expect(record).not.toBeNull();
  expect(record).toEqual({ error: kind, organizationId });
  const serialized = JSON.stringify(calls);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain('Error:');
  expect(serialized).not.toContain('stack');
}

describe('my-today: レビューで見つかった組織読み取りの境界と安全なログ', () => {
  test('認証時刻が失効時刻以下の組織には callback を渡さず、ほかの組織は読んで返す', async () => {
    const person = await createPerson();
    const protectedTarget = await organizationFor(person, 'あ再認証の工房', NOW);
    const ordinaryTarget = await organizationFor(person, 'い継続中の工房');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: { organizationId: string; userId: string }[] = [];
    const result = await readAccountTaskOrganizations(testEnv, accountOf(person), async (db, userId) => {
      seen.push({ organizationId: db.organizationId, userId });
      return '読めた';
    });
    expect(seen).toEqual([{ organizationId: ordinaryTarget.organization.id, userId: ordinaryTarget.user.id }]);
    expect(result.organizations).toEqual([{ organization: reference(ordinaryTarget), data: '読めた' }]);
    expect(result.failed_organizations).toEqual([reference(protectedTarget)]);
    expect(error).not.toHaveBeenCalled();
  });

  test.each([new Error(SECRET), new TypeError(SECRET), new RangeError(SECRET)])(
    'callback の $name は種類と組織IDだけを記録し、ほかの組織の結果を残す',
    async (failure) => {
      const person = await createPerson();
      const failedTarget = await organizationFor(person, 'あ失敗の工房');
      const ordinaryTarget = await organizationFor(person, 'い継続中の工房');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await readAccountTaskOrganizations(testEnv, accountOf(person), async (db) => {
        if (db.organizationId === failedTarget.organization.id) throw failure;
        return { title: '表示する仕事' };
      });
      expect(result.organizations).toEqual([
        { organization: reference(ordinaryTarget), data: { title: '表示する仕事' } },
      ]);
      expect(result.failed_organizations).toEqual([reference(failedTarget)]);
      expect(result.omitted_organizations).toBe(0);
      expectSafeLog(error.mock.calls, failedTarget.organization.id, failure.name);
    },
  );

  test('例外の name を任意値に変えられていても、本文や認証情報をログに漏らさない', async () => {
    const person = await createPerson();
    const target = await organizationFor(person, 'あ失敗の工房');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error(SECRET);
    failure.name = SECRET;
    const result = await readAccountTaskOrganizations(testEnv, accountOf(person), async () => {
      throw failure;
    });
    expect(result.failed_organizations).toEqual([reference(target)]);
    expectSafeLog(error.mock.calls, target.organization.id, 'UnknownError');
  });

  test('Error でない投げ値も丸ごと記録せず、安全な種類だけを残す', async () => {
    const person = await createPerson();
    const target = await organizationFor(person, 'あ失敗の工房');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await readAccountTaskOrganizations(testEnv, accountOf(person), async () => {
      throw { name: SECRET, message: SECRET, task: SECRET, token: SECRET };
    });
    expect(result.failed_organizations).toEqual([reference(target)]);
    expectSafeLog(error.mock.calls, target.organization.id, 'UnknownError');
  });

  test('503 の障害も安全な種類と組織IDだけをログに残し、ほかの組織は読んで返す', async () => {
    const person = await createPerson();
    const failedTarget = await organizationFor(person, 'あ障害の工房');
    const ordinaryTarget = await organizationFor(person, 'い継続中の工房');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await readAccountTaskOrganizations(testEnv, accountOf(person), async (db) => {
      if (db.organizationId === failedTarget.organization.id) {
        throw new ApiError(503, 'unavailable', { secret: SECRET });
      }
      return { title: '表示する仕事' };
    });
    expect(result.organizations).toEqual([
      { organization: reference(ordinaryTarget), data: { title: '表示する仕事' } },
    ]);
    expect(result.failed_organizations).toEqual([reference(failedTarget)]);
    expect(result.omitted_organizations).toBe(0);
    expectSafeLog(error.mock.calls, failedTarget.organization.id, 'UnknownError');
  });

  test.each([
    new ApiError(401, 'organization_reauth_required', { secret: SECRET }),
    new ApiError(403, 'organization_suspended', { secret: SECRET }),
    new ApiError(404, 'not_found', { secret: SECRET }),
  ])('既知の認可エラー $code は失敗組織として返し、エラーログを出さない', async (failure) => {
    const person = await createPerson();
    const target = await organizationFor(person, 'あ失敗の工房');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await readAccountTaskOrganizations(testEnv, accountOf(person), async () => {
      throw failure;
    });
    expect(result.organizations).toEqual([]);
    expect(result.failed_organizations).toEqual([reference(target)]);
    expect(error).not.toHaveBeenCalled();
  });
});
