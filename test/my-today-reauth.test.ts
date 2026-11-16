// 全組織の今日やることでも、組織ごとの認証失効時刻を越えた資格情報だけで中を読む。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { commonDb } from '../src/server/db/index.ts';
import { myToday } from '../src/shared/operations/organization/my-today.ts';
import { today } from '../src/shared/operations/organization/today.ts';
import { createMembership, createOrganization, createTask, createUser, createWorkspace } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
const CUTOFF = '2026-11-01T00:00:00.000Z';
const OLDER = '2026-10-31T23:59:59.999Z';
const NEWER = '2026-11-01T00:00:00.001Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T03:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

async function organizationFor(person: Person, name: string, credentialsNotBefore: string | null) {
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
  const task = await createTask(organization, workspace.id, user.id, {
    title: `${name}の本人の仕事`,
    assignee_user_id: user.id,
    today_on: '2026-11-02',
  });
  return { organization, task };
}

describe.each(['cookie', 'bearer'] as const)('my-today: %s の組織ごとの再認証', (credential) => {
  test.each([
    { name: '古い', createdAt: OLDER, allowed: false },
    { name: '失効と同時刻の', createdAt: CUTOFF, allowed: false },
    { name: '失効より新しい', createdAt: NEWER, allowed: true },
  ])('$name資格情報では組織内 today と同じ権限を守り、ほかの組織は表示する', async ({ createdAt, allowed }) => {
    const person = await createPerson({ sessionOverrides: { created_at: createdAt } });
    const protectedTarget = await organizationFor(person, 'あ再認証の工房', CUTOFF);
    const ordinaryTarget = await organizationFor(person, 'い継続中の工房', null);
    const credentials =
      credential === 'cookie'
        ? { token: person.token }
        : { bearer: (await insertApiToken(person.accountId, { scope: 'read', createdAt })).raw };

    const organizationResponse = await post(app, today, { ...credentials, slug: protectedTarget.organization.slug });
    expect(organizationResponse.status).toBe(allowed ? 200 : 401);
    if (!allowed)
      expect(await organizationResponse.json()).toMatchObject({ error: { code: 'organization_reauth_required' } });

    const response = await post(app, myToday, credentials);
    expect(response.status).toBe(200);
    const view = myToday.output.parse(await response.json());
    expect(view.tasks.map((task) => task.id).sort()).toEqual(
      (allowed ? [protectedTarget.task.id, ordinaryTarget.task.id] : [ordinaryTarget.task.id]).sort(),
    );
    expect(view.failed_organizations).toEqual(
      allowed
        ? []
        : [
            {
              slug: protectedTarget.organization.slug,
              name: protectedTarget.organization.name,
              kind: protectedTarget.organization.kind,
            },
          ],
    );
    expect(view.omitted_organizations).toBe(0);
  });
});

describe('my-today: API トークンの発行元の認証時刻', () => {
  test.each([
    {
      name: '発行が新しくても発行元の認証が古ければ拒否する',
      createdAt: NEWER,
      authenticatedAt: OLDER,
      allowed: false,
    },
    { name: '発行元の認証が新しければ作成日時では拒否しない', createdAt: OLDER, authenticatedAt: NEWER, allowed: true },
  ])('$name', async ({ createdAt, authenticatedAt, allowed }) => {
    const person = await createPerson();
    const protectedTarget = await organizationFor(person, 'あ再認証の工房', CUTOFF);
    const ordinaryTarget = await organizationFor(person, 'い継続中の工房', null);
    const token = await insertApiToken(person.accountId, { scope: 'read', createdAt });
    const db = commonDb(testEnv);
    await db.run(
      db.statement((q) =>
        q.updateTable('api_tokens').set({ authenticated_at: authenticatedAt }).where('token_hash', '=', token.hash),
      ),
    );
    const organizationResponse = await post(app, today, { bearer: token.raw, slug: protectedTarget.organization.slug });
    expect(organizationResponse.status).toBe(allowed ? 200 : 401);
    const response = await post(app, myToday, { bearer: token.raw });
    expect(response.status).toBe(200);
    const view = myToday.output.parse(await response.json());
    expect(view.tasks.map((task) => task.id).sort()).toEqual(
      (allowed ? [protectedTarget.task.id, ordinaryTarget.task.id] : [ordinaryTarget.task.id]).sort(),
    );
    expect(view.failed_organizations).toEqual(
      allowed
        ? []
        : [
            {
              slug: protectedTarget.organization.slug,
              name: protectedTarget.organization.name,
              kind: protectedTarget.organization.kind,
            },
          ],
    );
  });
});
