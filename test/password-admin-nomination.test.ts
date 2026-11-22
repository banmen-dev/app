// 運用者のパスワード管理者指名（#257）を、Workers とテスト用 D1 で確かめる。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { createApp } from '../src/server/app.ts';
import { hashPassword, verifyPassword } from '../src/server/auth/password-hash.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { randomToken, sha256Hex } from '../src/server/auth/tokens.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import {
  createOrganization as create,
  listOrganizations,
  organizationAdminReassign as reassign,
} from '../src/shared/operations/operator/index.ts';
import { consentRecord } from '../src/shared/operations/session/consent.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { AT, createOrganization, createUser } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, testEnv } from './operations/world.ts';

const app = createApp(undefined, { passwordLogin: true });
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;
const COOKIE = sessionCookieName(testEnv.PUBLIC_ORIGIN);
const CURRENT_PASSWORD = 'kiri-hibari-2026';
const NEW_PASSWORD = 'toki-sumire-2026';
const DISPLAY_NAME = '桐谷 ひばり';
const DAY_MS = 24 * 60 * 60 * 1000;

let ipCount = 0;
const newEmail = () => `hibari-${crypto.randomUUID()}@example.test`;
const orgDbOf = (id: string) => orgDb(env, verifiedOrganizationForTest(id));

function passwordRequest(path: string, body: unknown, token?: string) {
  const headers = new Headers({
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'CF-Connecting-IP': `100.90.0.${++ipCount}`,
  });
  if (token !== undefined) headers.set('Cookie', `${COOKIE}=${token}`);
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, testEnv);
}

function inspect(claimToken: string) {
  return passwordRequest('/api/auth/password/nomination/inspect', { claim_token: claimToken });
}

function accept(
  claimToken: string,
  input: { password: string; password_confirmation?: string; display_name?: string },
) {
  return passwordRequest('/api/auth/password/nomination/accept', { claim_token: claimToken, ...input });
}

function register(claimToken: string) {
  return accept(claimToken, {
    password: CURRENT_PASSWORD,
    password_confirmation: CURRENT_PASSWORD,
    display_name: DISPLAY_NAME,
  });
}

function credentialOf(email: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('password_credentials').selectAll().where('email', '=', email)));
}

function usersOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(db.statement((q) => q.selectFrom('users').selectAll().where('organization_id', '=', organizationId)));
}

async function waitingNomination({
  email = newEmail(),
  organization,
  expiresAt = new Date(Date.now() + DAY_MS).toISOString(),
  provider = 'password',
}: {
  email?: string;
  organization?: Awaited<ReturnType<typeof createOrganization>>;
  expiresAt?: string;
  provider?: 'google' | 'password';
} = {}) {
  const nominatedOrganization = organization ?? (await createOrganization());
  const claimToken = randomToken();
  const user = await createUser(nominatedOrganization, {
    login_provider: provider,
    login_subject: null,
    login_email: email,
    claim_token_hash: await sha256Hex(claimToken),
    claim_expires_at: expiresAt,
    name: email,
    is_admin: 1,
  });
  return { organization: nominatedOrganization, email, claimToken, user };
}

async function existingPasswordAccount(email: string) {
  const subject = crypto.randomUUID();
  const person = await createPerson({ login: { provider: 'password', subject } });
  // 反復回数を上げる前の資格情報も、指名で照合した際はそのまま残る。
  const hash = await hashPassword(CURRENT_PASSWORD, 1000);
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('password_credentials').values({
        login_subject: subject,
        email,
        password_hash: hash,
        display_name: DISPLAY_NAME,
        password_changed_at: AT,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
  return person;
}

function sessionTokenOf(response: Response): string | undefined {
  const cookie = response.headers.getSetCookie().find((line) => line.startsWith(`${COOKIE}=`));
  return cookie?.slice(COOKIE.length + 1).split(';')[0];
}

async function expectUnusable(claimToken: string) {
  for (const response of [await inspect(claimToken), await register(claimToken)]) {
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expect(response.headers.getSetCookie()).toEqual([]);
  }
}

type InviteResponse = { invite: { url: string; expires_at: string }; admin_login_name: string };

test('運用者がパスワードで最初の管理者を指名し、期限付きの URL を発行できる。一覧ではログイン待ちになる', async () => {
  const { token } = await getOperator();
  const email = newEmail();
  const slug = `pw-admin-${crypto.randomUUID().slice(0, 8)}`;
  const response = await post(app, create, {
    token,
    body: { slug, name: 'ひばり工房', admin: { provider: 'password', email: `  ${email.toUpperCase()}  ` } },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const { invite, admin_login_name } = (await response.json()) as InviteResponse;
  expect(admin_login_name).toBe(email);
  const url = new URL(invite.url);
  expect(url.origin).toBe(ORIGIN);
  expect(url.search).toBe('');
  const claimToken = url.hash.slice(1);
  expect(claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const db = commonDb(env);
  const organization = await db.first(
    db.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', slug)),
  );
  const users = await usersOf(organization!.id);
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({
    account_id: null,
    login_provider: 'password',
    login_subject: null,
    login_email: email,
    claim_token_hash: await sha256Hex(claimToken),
    claim_expires_at: invite.expires_at,
    is_admin: 1,
  });
  expect(Date.parse(invite.expires_at) - Date.parse(users[0]!.created_at)).toBe(14 * DAY_MS);

  const listed = await post(app, listOrganizations, { token });
  expect(listed.status).toBe(200);
  const listing = await listed.text();
  expect(listing).not.toContain(claimToken);
  const { organizations } = JSON.parse(listing) as { organizations: { slug: string; admin_status: string }[] };
  expect(organizations.find((item) => item.slug === slug)?.admin_status).toBe('pending');
  expect(await credentialOf(email)).toBeUndefined();
});

test('新規登録では本人が表示名とパスワードを決め、管理者のセッションで組織に入る。同じ URL は使い切る', async () => {
  const { organization, email, claimToken } = await waitingNomination();
  const inspected = await inspect(claimToken);
  expect(inspected.status).toBe(200);
  expect(inspected.headers.get('Cache-Control')).toBe('no-store');
  expect(await inspected.json()).toEqual({ email, existing_account: false });

  const response = await register(claimToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ return_to: `/${organization.slug}` });
  const token = sessionTokenOf(response);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const credential = await credentialOf(email);
  expect(credential).toMatchObject({ email, display_name: DISPLAY_NAME });
  expect(await verifyPassword(CURRENT_PASSWORD, credential!.password_hash)).toBe(true);

  const [user] = await usersOf(organization.id);
  expect(user).toMatchObject({
    login_subject: credential!.login_subject,
    login_email: null,
    claim_token_hash: null,
    claim_expires_at: null,
    name: DISPLAY_NAME,
    is_admin: 1,
    account_id: expect.any(String),
  });
  const db = commonDb(env);
  const tokenHash = await hashSessionToken(token!);
  const session = await db.first(
    db.statement((q) => q.selectFrom('sessions').select('account_id').where('token_hash', '=', tokenHash)),
  );
  expect(session?.account_id).toBe(user!.account_id);
  const consent = await post(app, consentRecord, {
    token,
    body: { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION },
  });
  expect(consent.status).toBe(200);
  const entered = await post(app, organizationInfo, { slug: organization.slug, token });
  expect(entered.status).toBe(200);
  expect(await entered.json()).toMatchObject({ me: { name: DISPLAY_NAME, is_admin: true } });
  await expectUnusable(claimToken);
});

test.each([
  ['表示名が空', { display_name: '  ' }],
  ['表示名がない', { display_name: undefined }],
  ['表示名が101文字', { display_name: '花'.repeat(101) }],
  ['パスワードの確認がない', { password_confirmation: undefined }],
  ['パスワードの確認が合わない', { password_confirmation: NEW_PASSWORD }],
])('新規登録で%sときは、資格情報を作らず URL を使い切らない', async (_label, input) => {
  const { email, claimToken, organization, user } = await waitingNomination();
  const response = await accept(claimToken, {
    password: CURRENT_PASSWORD,
    password_confirmation: CURRENT_PASSWORD,
    display_name: DISPLAY_NAME,
    ...input,
  });
  expect(response.status).toBe(400);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await credentialOf(email)).toBeUndefined();
  expect(await usersOf(organization.id)).toEqual([user]);
});

test('既存アカウントは現在のパスワードで照合して結び、保存済みの資格情報と表示名を保持する', async () => {
  const { organization, email, claimToken, user } = await waitingNomination();
  const person = await existingPasswordAccount(email);
  const original = await credentialOf(email);
  const inspected = await inspect(claimToken);
  expect(inspected.status).toBe(200);
  expect(await inspected.json()).toEqual({ email, existing_account: true });

  const rejected = await accept(claimToken, { password: NEW_PASSWORD });
  expect(rejected.status).toBe(401);
  expect(await errorCodeOf(rejected)).toBe('invalid_credentials');
  expect(rejected.headers.getSetCookie()).toEqual([]);
  expect(await credentialOf(email)).toEqual(original);
  expect(await usersOf(organization.id)).toEqual([user]);

  const accepted = await accept(claimToken, { password: CURRENT_PASSWORD });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ return_to: `/${organization.slug}` });
  expect(await credentialOf(email)).toEqual(original);
  const entered = await post(app, organizationInfo, { slug: organization.slug, token: sessionTokenOf(accepted) });
  expect(entered.status).toBe(200);
  expect(await entered.json()).toMatchObject({ me: { name: DISPLAY_NAME, is_admin: true } });
  expect(await usersOf(organization.id)).toMatchObject([
    { account_id: person.accountId, login_subject: person.login.subject, is_admin: 1, name: DISPLAY_NAME },
  ]);
});

test('パスワード変更後は、指名の結び付けでも変更後のパスワードを使う', async () => {
  const { email, claimToken, organization, user } = await waitingNomination();
  const person = await existingPasswordAccount(email);
  expect(
    (
      await passwordRequest(
        '/api/password-change',
        { current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD },
        person.token,
      )
    ).status,
  ).toBe(200);
  const afterChange = await credentialOf(email);
  const rejected = await accept(claimToken, { password: CURRENT_PASSWORD });
  expect(rejected.status).toBe(401);
  expect(await errorCodeOf(rejected)).toBe('invalid_credentials');
  expect(await usersOf(organization.id)).toEqual([user]);
  expect((await accept(claimToken, { password: NEW_PASSWORD })).status).toBe(200);
  expect(await credentialOf(email)).toEqual(afterChange);
});

test.each([
  ['期限切れ', { expiresAt: new Date(Date.now() - DAY_MS).toISOString() }],
  ['Google の指名', { provider: 'google' as const }],
])('%sの URL はパスワードでの登録に使えない', async (_label, options) => {
  const { claimToken, email, organization, user } = await waitingNomination(options);
  await expectUnusable(claimToken);
  expect(await credentialOf(email)).toBeUndefined();
  expect(await usersOf(organization.id)).toEqual([user]);
});

test('存在しない URL は使えない', async () => {
  await expectUnusable(randomToken());
});

test('パスワードで指名し直すと新しい URL が出て、前の URL は使えない', async () => {
  const previous = await waitingNomination();
  const email = newEmail();
  const response = await post(app, reassign, {
    token: (await getOperator()).token,
    body: { slug: previous.organization.slug, admin: { provider: 'password', email } },
  });
  expect(response.status).toBe(200);
  const { invite } = (await response.json()) as InviteResponse;
  const currentToken = new URL(invite.url).hash.slice(1);
  expect(currentToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(currentToken).not.toBe(previous.claimToken);
  await expectUnusable(previous.claimToken);
  expect(await credentialOf(previous.email)).toBeUndefined();
  const inspected = await inspect(currentToken);
  expect(inspected.status).toBe(200);
  expect(await inspected.json()).toEqual({ email, existing_account: false });
});

test('パスワードの経路を閉じている間は、指名の発行と URL からの登録を断る', async () => {
  const closedApp = createApp(undefined, { passwordLogin: false });
  const { email, claimToken, organization, user } = await waitingNomination();
  const { token } = await getOperator();
  const slug = `pw-admin-${crypto.randomUUID().slice(0, 8)}`;
  const admin = { provider: 'password', email };
  const created = await post(closedApp, create, { token, body: { slug, name: 'ひばり工房', admin } });
  expect(created.status).toBe(404);
  expect(await errorCodeOf(created)).toBe('not_found');
  const reassigned = await post(closedApp, reassign, { token, body: { slug: organization.slug, admin } });
  expect(reassigned.status).toBe(404);
  expect(await errorCodeOf(reassigned)).toBe('not_found');

  for (const action of ['inspect', 'accept']) {
    const response = await closedApp.request(
      `/api/auth/password/nomination/${action}`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({
          claim_token: claimToken,
          ...(action === 'accept'
            ? { password: CURRENT_PASSWORD, password_confirmation: CURRENT_PASSWORD, display_name: DISPLAY_NAME }
            : {}),
        }),
      },
      testEnv,
    );
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  expect(await credentialOf(email)).toBeUndefined();
  expect(await usersOf(organization.id)).toEqual([user]);
});
