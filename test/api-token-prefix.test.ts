// API トークンの接頭辞を sgp_ から bnp_ に改める（Issue #1428）。
// 新規の発行は bnp_、旧 sgp_ の発行済みトークンは API_TOKEN_LEGACY_LAST_DAY（UTC の日付）まで受け付ける
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  API_TOKEN_LEGACY_LAST_DAY,
  API_TOKEN_LEGACY_PREFIX,
  API_TOKEN_PATTERN,
  API_TOKEN_PREFIX,
  isLegacyApiTokenAccepted,
} from '../src/shared/api-token.ts';
import { tokenCreate } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { hashApiToken, issueApiToken, readApiToken } from '../src/server/auth/api-token.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createAccount } from './factories.ts';
import { insertApiToken, tokenRow } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson } from './operations/world.ts';
import { whoAmI, provisionalOperations } from './operations/provisional.ts';

const app = createApp(provisionalOperations);
const realApp = createApp([...implementedOperations]);
const BODY43 = 'A1_-'.repeat(10) + 'abc';
const LAST = new Date('2027-03-27T23:59:59.999Z');
const NEXT = new Date('2027-03-28T00:00:00.000Z');
const FIRST = new Date('2027-03-27T00:00:00.000Z');
const BEFORE_FIRST = new Date('2027-03-26T23:59:59.999Z');
// 旧トークンの期限は最終日より後にして、期限切れと区別する
const FAR = '2028-01-01T00:00:00.000Z';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function randomBody(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

describe('定数', () => {
  test('接頭辞と最終日', () => {
    expect(API_TOKEN_PREFIX).toBe('bnp_');
    expect(API_TOKEN_LEGACY_PREFIX).toBe('sgp_');
    expect(API_TOKEN_LEGACY_LAST_DAY).toBe('2027-03-27');
  });

  test('API_TOKEN_PATTERN は bnp_ と sgp_ の43文字を通し、それ以外は通さない', () => {
    expect(BODY43).toHaveLength(43);
    expect(API_TOKEN_PATTERN.test(`bnp_${BODY43}`)).toBe(true);
    expect(API_TOKEN_PATTERN.test(`sgp_${BODY43}`)).toBe(true);
    for (const bad of [
      BODY43,
      `bnp_${BODY43.slice(1)}`,
      `bnp_${BODY43}A`,
      `sgp_${BODY43.slice(1)}`,
      `sgp_${BODY43}A`,
      `BNP_${BODY43}`,
      `xbnp_${BODY43}`,
      `bnp_sgp_${BODY43}`,
      `ghp_${BODY43}`,
      `abc_${BODY43}`,
      `bnp_${BODY43.slice(1)}+`,
      `bnp_${BODY43.slice(1)} `,
      '',
    ]) {
      expect(API_TOKEN_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe('isLegacyApiTokenAccepted', () => {
  test('最終日の UTC の 00:00:00.000 と 23:59:59.999 は true', () => {
    expect(isLegacyApiTokenAccepted(FIRST)).toBe(true);
    expect(isLegacyApiTokenAccepted(LAST)).toBe(true);
    expect(isLegacyApiTokenAccepted(new Date('2027-03-27T12:00:00.000Z'))).toBe(true);
  });

  test('翌日の 00:00:00.000Z から false', () => {
    expect(isLegacyApiTokenAccepted(NEXT)).toBe(false);
    expect(isLegacyApiTokenAccepted(new Date('2027-03-28T00:00:00.001Z'))).toBe(false);
    expect(isLegacyApiTokenAccepted(new Date('2028-01-01T00:00:00.000Z'))).toBe(false);
  });

  test('最終日より前は true', () => {
    expect(isLegacyApiTokenAccepted(BEFORE_FIRST)).toBe(true);
    expect(isLegacyApiTokenAccepted(new Date('2026-11-27T00:00:00.000Z'))).toBe(true);
  });

  test('UTC の日付で判定する（+09:00 の表記でも UTC の日付）', () => {
    // 2027-03-28T08:00+09:00 = 2027-03-27T23:00Z は最終日
    expect(isLegacyApiTokenAccepted(new Date('2027-03-28T08:00:00+09:00'))).toBe(true);
    // 2027-03-28T09:00+09:00 = 2027-03-28T00:00Z は翌日
    expect(isLegacyApiTokenAccepted(new Date('2027-03-28T09:00:00+09:00'))).toBe(false);
  });
});

describe('issueApiToken', () => {
  test('bnp_ + 43文字で発行し、API_TOKEN_PATTERN に合う', async () => {
    const account = await createAccount();
    const raw = await issueApiToken(env, { accountId: account.id, name: 'x', scope: 'read', now: new Date() });
    expect(raw).toMatch(/^bnp_[A-Za-z0-9_-]{43}$/);
    expect(raw).toMatch(API_TOKEN_PATTERN);
    expect(raw.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(await tokenRow(await hashApiToken(raw))).toMatchObject({ account_id: account.id });
  });
});

describe('token-create の応答', () => {
  test('token は bnp_ + 43文字', async () => {
    const person = await createLoginPerson();
    const res = await post(realApp, tokenCreate, { token: person.token, body: { name: '手元の CLI', scope: 'read' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^bnp_[A-Za-z0-9_-]{43}$/);
  });

  test('応答の token で Bearer 認証の呼び出しができる', async () => {
    const person = await createLoginPerson();
    const created = await post(realApp, tokenCreate, { token: person.token, body: { name: 'x', scope: 'write' } });
    const { token } = (await created.json()) as { token: string };
    const res = await post(app, whoAmI, { bearer: token, origin: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_id: person.accountId });
  });
});

describe('readApiToken と bnp_', () => {
  test('bnp_ は期限と無関係に通る（最終日の翌日以降でも）', async () => {
    const account = await createAccount();
    const { raw } = await insertApiToken(account.id, { raw: `bnp_${randomBody()}`, expiresAt: FAR });
    for (const now of [BEFORE_FIRST, LAST, NEXT, new Date('2027-12-31T00:00:00.000Z')]) {
      expect(await readApiToken(env, raw, now), now.toISOString()).toMatchObject({ accountId: account.id });
    }
  });

  test('DB に無い bnp_ は undefined', async () => {
    expect(await readApiToken(env, `bnp_${randomBody()}`, FIRST)).toBeUndefined();
  });
});

describe('readApiToken と旧 sgp_', () => {
  test('最終日の 23:59:59.999Z までは通る', async () => {
    const account = await createAccount();
    const { raw } = await insertApiToken(account.id, { raw: `sgp_${randomBody()}`, expiresAt: FAR });
    for (const now of [BEFORE_FIRST, FIRST, LAST]) {
      expect(await readApiToken(env, raw, now), now.toISOString()).toMatchObject({
        accountId: account.id,
        tokenHash: await hashApiToken(raw),
      });
    }
  });

  test('翌日の 00:00:00.000Z から undefined（存在しないトークンと同じ）', async () => {
    const account = await createAccount();
    const { raw } = await insertApiToken(account.id, { raw: `sgp_${randomBody()}`, expiresAt: FAR });
    for (const now of [NEXT, new Date('2027-03-28T00:00:00.001Z'), new Date('2027-06-01T00:00:00.000Z')]) {
      expect(await readApiToken(env, raw, now), now.toISOString()).toBeUndefined();
    }
  });

  test('拒否したときは last_used_at を更新しない', async () => {
    const account = await createAccount();
    const { raw, hash } = await insertApiToken(account.id, { raw: `sgp_${randomBody()}`, expiresAt: FAR });
    const before = (await tokenRow(hash))!.last_used_at;
    expect(await readApiToken(env, raw, NEXT)).toBeUndefined();
    expect((await tokenRow(hash))!.last_used_at).toBe(before);
  });
});

describe('Bearer 認証の呼び出し', () => {
  test('旧 sgp_ は最終日の末尾まで 200、翌日の 00:00:00.000Z から 401', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { raw: `sgp_${randomBody()}`, expiresAt: FAR });
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(LAST);
    const ok = await post(app, whoAmI, { bearer: raw, origin: null });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ account_id: person.accountId });

    vi.setSystemTime(NEXT);
    const ng = await post(app, whoAmI, { bearer: raw, origin: null });
    expect(ng.status).toBe(401);
  });

  test('bnp_ は最終日の翌日以降も 200', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { raw: `bnp_${randomBody()}`, expiresAt: FAR });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-06-01T00:00:00.000Z'));
    const res = await post(app, whoAmI, { bearer: raw, origin: null });
    expect(res.status).toBe(200);
  });
});
