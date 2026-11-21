// パスワードの照合とセッションを変える書き込みが重なるときの順序を、D1 の読み取りに割り込んで固定する。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { hashPassword, verifyPassword } from '../src/server/auth/password-hash.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { me } from '../src/shared/operations/session/index.ts';
import { passwordChange } from '../src/shared/operations/session/password.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { AT, createSessionWithToken } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, testEnv } from './operations/world.ts';

const app = createApp(undefined, { passwordLogin: true });
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;
const COOKIE = sessionCookieName(testEnv.PUBLIC_ORIGIN);
const CURRENT = 'aoba-suzume-2026';
const CHANGED = 'aoba-kawasemi-2026';

async function passwordPerson() {
  const subject = crypto.randomUUID();
  const email = `password-race-${subject}@example.test`;
  const passwordHash = await hashPassword(CURRENT);
  const person = await createPerson({ login: { provider: 'password', subject } });
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('password_credentials').values({
        login_subject: subject,
        email,
        password_hash: passwordHash,
        display_name: '青葉 すずめ',
        password_changed_at: AT,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
  return { ...person, email };
}

function pauseAfterRead(matches: (sql: string) => boolean) {
  const entered = Promise.withResolvers<'reading'>();
  const released = Promise.withResolvers<void>();
  const pausedEnv = envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (!matches(sql)) return;
      entered.resolve('reading');
      await released.promise;
    },
  });
  return {
    env: pausedEnv,
    // 先に応答が返った場合は、読み取りを待ち続けずに失敗させる。
    untilRead: (request: Response | Promise<Response>) =>
      Promise.race([entered.promise, Promise.resolve(request).then((response) => response.status)]),
    release: () => released.resolve(),
  };
}

function change(token: string, next = CHANGED, requestEnv = testEnv) {
  return post(app, passwordChange, {
    token,
    body: { current_password: CURRENT, new_password: next },
    env: requestEnv,
  });
}

test('パスワード変更の前に済んだ照合では、変更後に古いパスワードのログインセッションを発行しない', async () => {
  const person = await passwordPerson();
  // パスワードでのログインは、照合できた後でアカウントを引く。
  const pause = pauseAfterRead((sql) => sql.startsWith('select "account_id" from "account_logins"'));
  const pendingLogin = app.request(
    '/api/auth/password/login',
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.91',
        Cookie: `${COOKIE}=${person.token}`,
      },
      body: JSON.stringify({ email: person.email, password: CURRENT }),
    },
    pause.env,
  );
  try {
    expect(await pause.untilRead(pendingLogin)).toBe('reading');
    expect((await change(person.token)).status).toBe(200);
  } finally {
    pause.release();
    await pendingLogin;
  }

  const response = await pendingLogin;
  expect(response.status).toBe(503);
  expect(await errorCodeOf(response)).toBe('unavailable');
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await sessionRowsOf(person.accountId)).toHaveLength(1);
  expect((await post(app, me, { token: person.token })).status).toBe(200);
});

test('同じパスワードの同時変更では、先に書き込んだ方のパスワードとセッションが残る', async () => {
  const person = await passwordPerson();
  const other = await createSessionWithToken(person.accountId);
  const pause = pauseAfterRead((sql) => sql.includes('"password_credentials"'));
  const pendingChange = change(other.token, 'aoba-yamase-2026', pause.env);
  try {
    expect(await pause.untilRead(pendingChange)).toBe('reading');
    expect((await change(person.token)).status).toBe(200);
  } finally {
    pause.release();
    await pendingChange;
  }

  const response = await pendingChange;
  expect(response.status).toBe(409);
  expect(await errorCodeOf(response)).toBe('conflict');
  const db = commonDb(env);
  const saved = await db.first(
    db.statement((q) =>
      q.selectFrom('password_credentials').select('password_hash').where('login_subject', '=', person.login.subject),
    ),
  );
  expect(await verifyPassword(CHANGED, saved?.password_hash ?? '')).toBe(true);
  expect(await sessionRowsOf(person.accountId)).toHaveLength(1);
  expect((await post(app, me, { token: person.token })).status).toBe(200);
  expect((await post(app, me, { token: other.token })).status).toBe(401);
});
