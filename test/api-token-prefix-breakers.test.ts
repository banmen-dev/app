// Issue #1428 の崩す側のテスト。bnp_ / sgp_ の検証、最終日の境界、Bearer と Cookie、feedback の秘密検知を崩しにいく
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { API_TOKEN_LEGACY_LAST_DAY, API_TOKEN_PATTERN, isLegacyApiTokenAccepted } from '../src/shared/api-token.ts';
import { createApp } from '../src/server/app.ts';
import { hashApiToken, readApiToken } from '../src/server/auth/api-token.ts';
import { feedbackSubmit } from '../src/shared/operations/feedback.ts';
import { fakeFeedbackGithubEnv, fakeFeedbackGithubResponse, FEEDBACK_ISSUES_URL } from './feedback/fake-github-app.ts';
import { createAccount } from './factories.ts';
import { insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, createPerson, testEnv } from './operations/world.ts';
import { provisionalOperations, whoAmI } from './operations/provisional.ts';

const app = createApp(provisionalOperations);
const LAST = new Date('2027-03-27T23:59:59.999Z');
const NEXT = new Date('2027-03-28T00:00:00.000Z');
const FAR = '2029-01-01T00:00:00.000Z';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function body43(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

describe('日付の境界', () => {
  test('最終日の定数は UTC の日付で、日本時間の最終日の終わり（UTC 15:00）では受けない側に倒れない', () => {
    expect(API_TOKEN_LEGACY_LAST_DAY).toBe('2027-03-27');
    // 2027-03-27T15:00Z は JST の 3/28 00:00。UTC の日付はまだ 3/27 なので受ける
    expect(isLegacyApiTokenAccepted(new Date('2027-03-27T15:00:00.000Z'))).toBe(true);
    // JST の 3/27 00:00 = UTC 3/26 15:00 も受ける
    expect(isLegacyApiTokenAccepted(new Date('2027-03-27T00:00:00+09:00'))).toBe(true);
    // 負のオフセット: 2027-03-27T20:00-05:00 = UTC 3/28 01:00 は断る
    expect(isLegacyApiTokenAccepted(new Date('2027-03-27T20:00:00-05:00'))).toBe(false);
  });

  test('1ms 刻みで最終日の終わりと翌日の始まりを分ける', () => {
    expect(isLegacyApiTokenAccepted(new Date(NEXT.getTime() - 1))).toBe(true);
    expect(isLegacyApiTokenAccepted(new Date(NEXT.getTime()))).toBe(false);
  });

  // 根拠: 完了条件「翌日 00:00:00.000Z から存在しないトークンと同じに拒否する」。
  // toISOString が +YYYYYY- の拡張年を返すと、文字列比較で '+' < '2' となり、遠い未来が「最終日以前」になる
  test('西暦10000年以降の時刻でも旧トークンを受けない', () => {
    expect(isLegacyApiTokenAccepted(new Date('+010000-01-01T00:00:00.000Z'))).toBe(false);
    expect(isLegacyApiTokenAccepted(new Date(8.64e15))).toBe(false);
  });

  // 根拠: 同上。不正な Date（うるう秒 23:59:60 の文字列など）で例外を投げず、受けない側に倒す
  test('不正な Date（NaN、うるう秒の文字列）は例外にせず false', () => {
    const leap = new Date('2027-03-27T23:59:60.000Z');
    expect(Number.isNaN(leap.getTime())).toBe(true);
    expect(() => isLegacyApiTokenAccepted(leap)).not.toThrow();
    expect(isLegacyApiTokenAccepted(leap)).toBe(false);
    expect(() => isLegacyApiTokenAccepted(new Date(NaN))).not.toThrow();
  });
});

describe('形の抜け', () => {
  const B = body43();
  test.each([
    ['大文字', `BNP_${B}`],
    ['混在', `Bnp_${B}`],
    ['SGP', `SGP_${B}`],
    ['前の空白', ` bnp_${B}`],
    ['後ろの空白', `bnp_${B} `],
    ['後ろの改行', `bnp_${B}\n`],
    ['前の改行', `\nbnp_${B}`],
    ['途中の改行', `bnp_${B.slice(0, 20)}\n${B.slice(20)}`],
    ['タブ', `bnp_${B}\t`],
    ['全角の下線', `bnp＿${B}`],
    ['42文字', `bnp_${B.slice(1)}`],
    ['44文字', `bnp_${B}A`],
    ['接頭辞が二重', `bnp_bnp_${B}`],
  ])('API_TOKEN_PATTERN は %s を通さない', (_label, value) => {
    expect(API_TOKEN_PATTERN.test(value)).toBe(false);
  });

  test.each([`bnp_${B}\n`, ` sgp_${B}`, `BNP_${B}`])(
    'readApiToken は形の違う値 %j を DB を引く前に断る',
    async (value) => {
      const account = await createAccount();
      // 形の違う値そのものの行があっても通さない
      await insertApiToken(account.id, { raw: value, expiresAt: FAR });
      expect(await readApiToken(env, value, new Date('2026-12-01T00:00:00.000Z'))).toBeUndefined();
    },
  );

  test('同じ本体で接頭辞だけ違う値は別のトークン（ハッシュも違い、取り違えで通らない）', async () => {
    const account = await createAccount();
    const body = body43();
    const now = new Date('2027-01-01T00:00:00.000Z');
    expect(await hashApiToken(`bnp_${body}`)).not.toBe(await hashApiToken(`sgp_${body}`));
    await insertApiToken(account.id, { raw: `bnp_${body}`, expiresAt: FAR });
    expect(await readApiToken(env, `sgp_${body}`, now)).toBeUndefined();
    expect(await readApiToken(env, `bnp_${body}`, now)).toMatchObject({ accountId: account.id });

    const other = await createAccount();
    const body2 = body43();
    await insertApiToken(other.id, { raw: `sgp_${body2}`, expiresAt: FAR });
    expect(await readApiToken(env, `bnp_${body2}`, now)).toBeUndefined();
    expect(await readApiToken(env, `sgp_${body2}`, now)).toMatchObject({ accountId: other.id });
  });

  test('bnp_ の同じ本体の読み取りは、sgp_ の行の last_used_at を動かさない', async () => {
    const account = await createAccount();
    const body = body43();
    const { hash } = await insertApiToken(account.id, { raw: `sgp_${body}`, expiresAt: FAR });
    const before = (await tokenRow(hash))!.last_used_at;
    await readApiToken(env, `bnp_${body}`, new Date('2027-01-01T00:00:00.000Z'));
    expect((await tokenRow(hash))!.last_used_at).toBe(before);
  });
});

describe('旧 sgp_ の失効は最終日まで従来どおり効く', () => {
  const day = new Date('2027-03-27T12:00:00.000Z');

  test('取消済みの sgp_ は最終日でも通らず、last_used_at も進まない', async () => {
    const account = await createAccount();
    const { raw, hash } = await insertApiToken(account.id, {
      raw: `sgp_${body43()}`,
      expiresAt: FAR,
      revokedAt: '2027-03-01T00:00:00.000Z',
    });
    const before = (await tokenRow(hash))!.last_used_at;
    expect(await readApiToken(env, raw, day)).toBeUndefined();
    expect((await tokenRow(hash))!.last_used_at).toBe(before);
  });

  test('期限が最終日より前の sgp_ は、最終日には通らない', async () => {
    const account = await createAccount();
    const { raw } = await insertApiToken(account.id, { raw: `sgp_${body43()}`, expiresAt: '2027-03-27T06:00:00.000Z' });
    expect(await readApiToken(env, raw, new Date('2027-03-27T05:59:59.999Z'))).toMatchObject({ accountId: account.id });
    expect(await readApiToken(env, raw, new Date('2027-03-27T06:00:00.000Z'))).toBeUndefined();
    expect(await readApiToken(env, raw, day)).toBeUndefined();
  });

  test('期限が最終日の後の sgp_ は、最終日の終わりまで通り、通るたびに last_used_at が進む', async () => {
    const account = await createAccount();
    const { raw, hash } = await insertApiToken(account.id, { raw: `sgp_${body43()}`, expiresAt: FAR });
    expect(await readApiToken(env, raw, LAST)).toMatchObject({ accountId: account.id });
    expect((await tokenRow(hash))!.last_used_at).toBe(LAST.toISOString());
  });

  test('最終日の翌日に断った sgp_ は、取り消しの有無にかかわらず行を一切書き換えない', async () => {
    const account = await createAccount();
    const { raw, hash } = await insertApiToken(account.id, { raw: `sgp_${body43()}`, expiresAt: FAR });
    const before = await tokenRow(hash);
    expect(await readApiToken(env, raw, NEXT)).toBeUndefined();
    expect(await tokenRow(hash)).toEqual(before);
  });
});

describe('Bearer と Cookie の経路', () => {
  test('最終日の翌日、失効した sgp_ の Bearer は、有効な Cookie があっても 401（Cookie に落とさない）', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { raw: `sgp_${body43()}`, expiresAt: FAR });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NEXT);
    const res = await post(app, whoAmI, { token: person.token, bearer: raw });
    expect(res.status).toBe(401);
  });

  test('Bearer の値の前後の空白は trim され、最終日の翌日でも sgp_ は 401 のまま', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { raw: `sgp_${body43()}`, expiresAt: FAR });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NEXT);
    const res = await post(app, whoAmI, { bearer: `  ${raw}  `, origin: null });
    expect(res.status).toBe(401);
  });

  test('小文字の bearer は Bearer と見なさず Cookie の経路。トークンの形の値を Cookie に入れても通らない', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { raw: `bnp_${body43()}`, expiresAt: FAR });
    const res = await post(app, whoAmI, { headers: { Authorization: `bearer ${raw}` } });
    expect(res.status).toBe(401);
    const asCookie = await post(app, whoAmI, { token: raw });
    expect(asCookie.status).toBe(401);
  });

  test('401 の本文に値を出さない', async () => {
    const raw = `sgp_${body43()}`;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NEXT);
    const res = await post(app, whoAmI, { bearer: raw, origin: null });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(raw.slice(4));
  });
});

describe('bnp_ を拒否する側の副作用', () => {
  test('存在しない・取消済み・期限切れの bnp_ は行を書き換えず、ログにも値を出さない', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ];
    const account = await createAccount();
    const now = new Date('2027-06-01T00:00:00.000Z');
    const revoked = await insertApiToken(account.id, {
      raw: `bnp_${body43()}`,
      expiresAt: FAR,
      revokedAt: '2027-05-01T00:00:00.000Z',
    });
    const expired = await insertApiToken(account.id, { raw: `bnp_${body43()}`, expiresAt: '2027-05-31T00:00:00.000Z' });
    const missing = `bnp_${body43()}`;
    const before = await tokenRowsOf(account.id);

    for (const raw of [revoked.raw, expired.raw, missing]) expect(await readApiToken(env, raw, now)).toBeUndefined();
    expect(await tokenRowsOf(account.id)).toEqual(before);

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const raw of [revoked.raw, expired.raw, missing]) {
      expect(logged).not.toContain(raw);
      expect(logged).not.toContain(raw.slice(4));
    }
  });
});

describe('feedback の秘密検知', () => {
  const B = 'a'.repeat(43);
  async function submitText(text: string) {
    const person = await createPerson();
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (requestInput, init) => {
      const request = new Request(requestInput, init);
      requests.push(request);
      const response = fakeFeedbackGithubResponse(request);
      if (response) return response;
      throw new Error('想定外のフィードバックの送信先');
    };
    const feedbackApp = createApp(undefined, { fetcher });
    const res = await post(feedbackApp, feedbackSubmit, {
      env: await fakeFeedbackGithubEnv(testEnv),
      token: person.token,
      body: {
        text,
        route_id: '/[slug]/w/[id]/board',
        url: new URL('/test-private-org/w/test-private-workspace/board', testEnv.PUBLIC_ORIGIN).href,
      },
    });
    const issues = requests.filter((r) => r.url === FEEDBACK_ISSUES_URL && r.method === 'POST');
    return { res, issues };
  }

  test.each([
    ['soft hyphen', `b­np_${B}`],
    ['zero width joiner', `bn‍p_${B}`],
    ['bidi mark', `bnp_‎${B}`],
    ['改行コードの正規化', `bnp_${B}\r\n`],
    ['BOM', `﻿bnp_${B}`],
    ['Bearer 付き', `Authorization: Bearer bnp_${B}`],
    ['URL の中', `https://example.test/?t=sgp_${B}`],
    ['短い本体', 'bnp_abc'],
  ])('%s でも bnp_ / sgp_ の秘密として断る', async (_label, text) => {
    const { res, issues } = await submitText(`貼った ${text}`);
    expect(res.status).toBe(400);
    expect(issues).toHaveLength(0);
  });
});
