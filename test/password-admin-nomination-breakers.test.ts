// 管理者の指名を処理している間に、別の登録・指名・パスワード変更が進んだときの整合性を確かめる。
import { env } from 'cloudflare:workers';
import { expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { hashPassword, verifyPassword } from '../src/server/auth/password-hash.ts';
import { randomToken, sha256Hex } from '../src/server/auth/tokens.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { organizationAdminReassign } from '../src/shared/operations/operator/organization-admin-reassign.ts';
import { passwordChange } from '../src/shared/operations/session/password.ts';
import { AT, createMembership, createOrganization, createUser, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, testEnv } from './operations/world.ts';

const app = createApp(undefined, { passwordLogin: true });
const origin = new URL(testEnv.PUBLIC_ORIGIN).origin;
const firstPassword = 'kawasemi-nagisa-2026';
const secondPassword = 'tsubame-sumire-2026';

let ipCount = 0;

function request(action: 'inspect' | 'accept', body: object, requestEnv = testEnv) {
  return app.request(
    '/api/auth/password/nomination/' + action,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'CF-Connecting-IP': '100.91.0.' + ++ipCount,
      },
      body: JSON.stringify(body),
    },
    requestEnv,
  );
}

function register(token: string, password: string, name: string, requestEnv = testEnv) {
  return request(
    'accept',
    { claim_token: token, password, password_confirmation: password, display_name: name },
    requestEnv,
  );
}

function newEmail() {
  return 'tsubame-' + crypto.randomUUID() + '@example.test';
}

async function nominate(organization: Awaited<ReturnType<typeof createOrganization>>, email = newEmail()) {
  const token = randomToken();
  const user = await createUser(organization, {
    account_id: null,
    is_admin: 1,
    login_provider: 'password',
    login_subject: null,
    login_email: email,
    claim_token_hash: await sha256Hex(token),
    claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
    name: email,
  });
  return { organization, email, user, token };
}

type Nomination = Awaited<ReturnType<typeof nominate>>;

function nominatedUser(nomination: Nomination) {
  const db = orgDb(env, verifiedOrganizationForTest(nomination.organization.id));
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .selectAll()
        .where('organization_id', '=', nomination.organization.id)
        .where('id', '=', nomination.user.id),
    ),
  );
}

function credential(email: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('password_credentials').selectAll().where('email', '=', email)));
}

test('同じメールアドレスの指名を2組織で同時に登録すると、先に登録された資格情報だけで両方を結べる', async () => {
  const first = await nominate(await createOrganization());
  const second = await nominate(await createOrganization(), first.email);
  const inputs = [
    { nomination: first, password: firstPassword, name: '汀 かわせみ' },
    { nomination: second, password: secondPassword, name: '菫 つばめ' },
  ];
  const results = await Promise.all(
    inputs.map(({ nomination, password, name }) => register(nomination.token, password, name)),
  );
  expect(results.map((response) => response.status).sort()).toEqual([200, 401]);

  const winnerIndex = results.findIndex((response) => response.ok);
  const winner = inputs[winnerIndex]!;
  const loser = inputs[1 - winnerIndex]!;
  expect(results[1 - winnerIndex]!.headers.getSetCookie()).toEqual([]);
  expect(await nominatedUser(loser.nomination)).toEqual(loser.nomination.user);
  const saved = await credential(first.email);
  expect(saved?.display_name).toBe(winner.name);
  expect(await verifyPassword(winner.password, saved!.password_hash)).toBe(true);
  expect(await verifyPassword(loser.password, saved!.password_hash)).toBe(false);

  const retry = await request('accept', { claim_token: loser.nomination.token, password: winner.password });
  expect(retry.status).toBe(200);
  expect(await credential(first.email)).toEqual(saved);
  const linkedFirst = await nominatedUser(first);
  const linkedSecond = await nominatedUser(second);
  expect(linkedFirst).toMatchObject({
    account_id: expect.any(String),
    login_subject: saved!.login_subject,
    is_admin: 1,
    name: winner.name,
  });
  expect(linkedSecond).toMatchObject({
    account_id: linkedFirst!.account_id,
    login_subject: saved!.login_subject,
    is_admin: 1,
    name: winner.name,
  });
});

test('照会の後に停止された組織の指名では資格情報を作らない', async () => {
  const nomination = await nominate(await createOrganization());
  expect((await request('inspect', { claim_token: nomination.token })).status).toBe(200);
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('organizations')
        .set({ suspended_at: new Date().toISOString() })
        .where('id', '=', nomination.organization.id),
    ),
  ]);

  const result = await register(nomination.token, firstPassword, '汀 かわせみ');
  expect(result.status).toBe(404);
  expect(result.headers.getSetCookie()).toEqual([]);
  expect(await credential(nomination.email)).toBeUndefined();
  expect(await nominatedUser(nomination)).toEqual(nomination.user);
});

test('指名を結ぶ直前に再指名され、所属がある待ち行が残っても、古い指名は使えない', async () => {
  const organization = await createOrganization();
  const nomination = await nominate(organization);
  const admin = await createPerson({ organization, admin: true });
  const workspace = await createWorkspace(organization, admin.userId!);
  await createMembership(organization, workspace.id, nomination.user.id, { role: 'leader' });
  let reads = 0;
  let reassignStatus: number | undefined;
  const operator = await getOperator();
  const racingEnv = envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (!sql.includes('from "users"') || !sql.includes('"claim_token_hash"') || ++reads !== 2) return;
      const response = await post(app, organizationAdminReassign, {
        token: operator.token,
        body: { slug: organization.slug, admin: { provider: 'password', email: newEmail() } },
      });
      reassignStatus = response.status;
    },
  });

  const result = await register(nomination.token, firstPassword, '汀 かわせみ', racingEnv);
  expect(reassignStatus).toBe(200);
  expect(result.status).toBe(404);
  expect(result.headers.getSetCookie()).toEqual([]);
  expect(await nominatedUser(nomination)).toMatchObject({
    is_admin: 0,
    account_id: null,
    login_subject: null,
  });
  expect((await request('inspect', { claim_token: nomination.token })).status).toBe(404);
});

test('現在のパスワードを読み取った直後に変更されると、変更前のパスワードで指名を消費しない', async () => {
  const nomination = await nominate(await createOrganization());
  const subject = crypto.randomUUID();
  const person = await createPerson({ login: { provider: 'password', subject } });
  const db = commonDb(env);
  const passwordHash = await hashPassword(firstPassword, 1000);
  await db.batch([
    db.statement((q) =>
      q.insertInto('password_credentials').values({
        login_subject: subject,
        email: nomination.email,
        password_hash: passwordHash,
        display_name: '汀 かわせみ',
        password_changed_at: AT,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
  let changeStatus: number | undefined;
  const racingEnv = envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (changeStatus !== undefined || !sql.includes('from "password_credentials"')) return;
      const response = await post(app, passwordChange, {
        token: person.token,
        body: { current_password: firstPassword, new_password: secondPassword },
      });
      changeStatus = response.status;
    },
  });

  const rejected = await request('accept', { claim_token: nomination.token, password: firstPassword }, racingEnv);
  expect(changeStatus).toBe(200);
  expect(rejected.status).toBe(401);
  expect(rejected.headers.getSetCookie()).toEqual([]);
  expect(await nominatedUser(nomination)).toEqual(nomination.user);

  const accepted = await request('accept', { claim_token: nomination.token, password: secondPassword });
  expect(accepted.status).toBe(200);
  expect(await nominatedUser(nomination)).toMatchObject({ account_id: person.accountId, login_subject: subject });
});

test('指名の結果は定義済みの POST だけを手段と結果に分けて記録する', async () => {
  const nomination = await nominate(await createOrganization());
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect((await request('inspect', { claim_token: nomination.token })).status).toBe(200);
    expect((await request('accept', { claim_token: 'invalid', password: firstPassword })).status).toBe(404);
    expect((await app.request('/api/auth/password/nomination/unknown', { method: 'POST' }, testEnv)).status).toBe(404);
    expect((await app.request('/api/auth/password/nomination/inspect', { method: 'GET' }, testEnv)).status).toBe(404);

    const entries = log.mock.calls
      .map(([value]) => JSON.parse(String(value)) as { step?: string; outcome?: string })
      .filter(({ step }) => step?.startsWith('nomination_'));
    expect(entries).toEqual([
      expect.objectContaining({ step: 'nomination_inspect', outcome: 'ok' }),
      expect.objectContaining({ step: 'nomination_accept', outcome: 'not_found' }),
    ]);
    expect(JSON.stringify(entries)).not.toContain(nomination.token);
    expect(JSON.stringify(entries)).not.toContain(nomination.email);
    expect(JSON.stringify(entries)).not.toContain(firstPassword);
  } finally {
    log.mockRestore();
  }
});
