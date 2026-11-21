// ログイン中のパスワード変更（#260）。ブラウザと同じ API を Workers とテスト用 D1 に通す。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { hashPassword } from '../src/server/auth/password-hash.ts';
import { commonDb } from '../src/server/db/index.ts';
import { me } from '../src/shared/operations/session/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { spyPbkdf2 } from './auth/pbkdf2-spy.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { AT, createSessionWithToken } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, testEnv } from './operations/world.ts';

const app = createApp(undefined, { passwordLogin: true });
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;
const COOKIE = sessionCookieName(testEnv.PUBLIC_ORIGIN);
const CURRENT_PASSWORD = 'すみれの手紙-Haruno2026';
const NEW_PASSWORD = 'こもれびの地図-Café2026';
const WRONG_PASSWORD = 'ひばりの地図-Hibari2026';

async function passwordPerson(options: { consented?: boolean } = {}) {
  const subject = crypto.randomUUID();
  const email = `sumire-${subject}@example.test`;
  const storedHash = await hashPassword(CURRENT_PASSWORD);
  const person = await createPerson({ login: { provider: 'password', subject }, ...options });
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('password_credentials').values({
        login_subject: subject,
        email,
        password_hash: storedHash,
        display_name: '春野 すみれ',
        password_changed_at: AT,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
  return { ...person, email, storedHash };
}

function credential(subject: string) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) => q.selectFrom('password_credentials').selectAll().where('login_subject', '=', subject)),
  );
}

function change(
  token: string | undefined,
  {
    current = CURRENT_PASSWORD,
    next = NEW_PASSWORD,
    headers = {},
  }: {
    current?: string;
    next?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return app.request(
    '/api/password-change',
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        ...(token === undefined ? {} : { Cookie: `${COOKIE}=${token}` }),
        ...headers,
      },
      body: JSON.stringify({ current_password: current, new_password: next }),
    },
    testEnv,
  );
}

function login(email: string, password: string, ip: string) {
  return app.request(
    '/api/auth/password/login',
    {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email, password }),
    },
    testEnv,
  );
}

async function expectFailure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await errorCodeOf(response)).toBe(code);
}

test('書き換え後は自分の今の Cookie が残り、自分の他の Cookie はすべて無効になる', async () => {
  const person = await passwordPerson();
  const newer = await createSessionWithToken(person.accountId, {
    created_at: new Date(Date.now() + 1000).toISOString(),
  });
  const older = await createSessionWithToken(person.accountId, { created_at: AT });
  const stranger = await createPerson();
  const before = await credential(person.login.subject);

  const response = await change(person.token, { next: NEW_PASSWORD.normalize('NFD') });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({});

  const after = await credential(person.login.subject);
  expect(after).toMatchObject({ email: before?.email, created_at: before?.created_at });
  expect(after?.password_hash).not.toBe(person.storedHash);
  expect(after?.password_changed_at).not.toBe(before?.password_changed_at);
  expect(await sessionRowsOf(person.accountId)).toHaveLength(1);
  expect((await post(app, me, { token: person.token })).status).toBe(200);
  await expectFailure(await post(app, me, { token: older.token }), 401, 'unauthenticated');
  await expectFailure(await post(app, me, { token: newer.token }), 401, 'unauthenticated');
  expect((await post(app, me, { token: stranger.token })).status).toBe(200);

  await expectFailure(await login(person.email, CURRENT_PASSWORD, '203.0.113.30'), 401, 'invalid_credentials');
  expect((await login(person.email, NEW_PASSWORD, '203.0.113.30')).status).toBe(200);
});

test('今のパスワードが異なる場合と新しいパスワードが規則に合わない場合は書き換えも失効も起きない', async () => {
  const person = await passwordPerson();
  const other = await createSessionWithToken(person.accountId);
  const before = await credential(person.login.subject);

  await expectFailure(await change(person.token, { current: WRONG_PASSWORD }), 400, 'invalid_credentials');
  await expectFailure(await change(person.token, { next: '短すぎる' }), 400, 'invalid_input');

  expect(await credential(person.login.subject)).toEqual(before);
  expect((await post(app, me, { token: person.token })).status).toBe(200);
  expect((await post(app, me, { token: other.token })).status).toBe(200);
});

test('変更の照合はアカウント単位で10回まで。別セッションやIPからも超えられず、ログインは独立する', async () => {
  const person = await passwordPerson();
  const other = await createSessionWithToken(person.accountId);
  const alternate = await passwordPerson();
  const spy = spyPbkdf2();
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expectFailure(await change(person.token, { current: WRONG_PASSWORD }), 400, 'invalid_credentials');
    }
    await expectFailure(await change(other.token, { current: WRONG_PASSWORD }), 400, 'invalid_credentials');
    expect((await change(person.token)).status).toBe(200);
    const checked = spy.iterations();
    await expectFailure(
      await change(person.token, {
        current: NEW_PASSWORD,
        headers: { 'CF-Connecting-IP': '203.0.113.32' },
      }),
      429,
      'rate_limited',
    );
    expect(spy.iterations()).toEqual(checked);
    await expectFailure(await post(app, me, { token: other.token }), 401, 'unauthenticated');
    expect((await login(person.email, NEW_PASSWORD, '203.0.113.32')).status).toBe(200);
    expect((await change(alternate.token)).status).toBe(200);
  } finally {
    spy.restore();
  }
});

test('OAuth のアカウント、Cookie のない呼び出し、API トークン、未同意は変更できない', async () => {
  const oauth = await createPerson();
  const person = await passwordPerson();
  const unconsented = await passwordPerson({ consented: false });
  const { raw } = await insertApiToken(person.accountId);
  await expectFailure(await change(oauth.token), 403, 'forbidden');
  await expectFailure(await change(undefined), 401, 'unauthenticated');
  await expectFailure(await change(undefined, { headers: { Authorization: `Bearer ${raw}` } }), 403, 'forbidden');
  await expectFailure(await change(unconsented.token), 403, 'terms_required');
});
