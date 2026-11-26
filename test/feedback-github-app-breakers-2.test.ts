// フィードバックの GitHub App の層（src/server/feedback/github-app.ts）を崩す側から確かめるテストの2周目（Issue #1552）。
// test/feedback-github-app.test.ts と test/feedback-github-app-breakers.test.ts と重ならない手口だけを置く:
// 除いた文字の両側のサロゲートの片割れがつながって生まれる除くべき文字、鍵の取り込みと署名の一時的な失敗の後の再試行、
// 応答の本文を読む途中で止まったときの分類、console への出力、JSON に直したときの往復。
// 鍵はテストの中で作る架空の鍵、トークンと文はすべて架空。見えない文字とサロゲートはソースに直に書かず、番号から作る
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createFeedbackGithubClient,
  feedbackIssueBody,
  feedbackIssueTitle,
  FeedbackIssueError,
  normalizeFeedbackText,
  type FeedbackGithubCredentials,
  type FeedbackIssueFailure,
  type FeedbackIssueInput,
} from '../src/server/feedback/github-app.ts';

const APP_ID = '864201';
const INSTALLATION_ID = '9753102';
const TOKEN_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const ISSUES_URL = 'https://api.github.com/repos/banmen-dev/app/issues';
const TOKEN = 'ghs_SecondBreakerFakeToken0003';
// 2026-11-26 07:20:30 UTC
const NOW = Date.UTC(2026, 10, 26, 7, 20, 30);
const HOUR = 60 * 60 * 1000;
const FEEDBACK_ID = '019a8f41-2b3c-7d4e-8f50-6a7b8c9d0e1f';
// String.fromCharCode はサロゲートの片割れを1つずつ作れる（fromCodePoint も同じだが、意図を明らかにする）
const unit = (...codes: number[]) => String.fromCharCode(...codes);
const ZWSP = unit(0x200b);
const NUL = unit(0x0000);
const RLO = unit(0x202e);

// ---- 鍵 ----

function base64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlDecode(part: string): Uint8Array {
  const padded = part
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(part.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const keyPair = (async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const lines = base64(pkcs8).match(/.{1,64}/g) ?? [];
  const pem = ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
  return { pem, publicKey: pair.publicKey };
})();

async function credentials(): Promise<FeedbackGithubCredentials> {
  const { pem } = await keyPair;
  return { appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: pem };
}

async function verifyBearerJwt(authorization: string | null): Promise<boolean> {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
  if (!match) return false;
  const { publicKey } = await keyPair;
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlDecode(match[3]),
    new TextEncoder().encode(`${match[1]}.${match[2]}`),
  );
}

// ---- fetch の差し替え ----

type Seen = { request: Request; body: string };
type Responder = (request: Request, index: number) => Response | Promise<Response>;

const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const tokenOk = () => json({ token: TOKEN, expires_at: new Date(NOW + HOUR).toISOString() }, 201);
const issueOk = (number = 55) => json({ number }, 201);

function githubFetcher(options: { token?: Responder; issue?: Responder } = {}) {
  const seen: Seen[] = [];
  let tokenCount = 0;
  let issueCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({ request, body: await request.clone().text() });
    if (request.url === TOKEN_URL) return (options.token ?? (() => tokenOk()))(request, tokenCount++);
    if (request.url === ISSUES_URL) return (options.issue ?? (() => issueOk()))(request, issueCount++);
    return new Response('not found', { status: 404 });
  };
  return { seen, fetcher };
}

const tokenRequests = (seen: Seen[]) => seen.filter((s) => s.request.url === TOKEN_URL);
const issueRequests = (seen: Seen[]) => seen.filter((s) => s.request.url === ISSUES_URL);

// 本文の読み取りの途中で、実行環境のタイムアウトと同じ名前の例外で止まる応答（ヘッダーは届いた後に本文が止まる）
function stalledBody(status: number, firstChunk: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
      controller.error(new DOMException('本文の途中で止まった', 'TimeoutError'));
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'application/json' } });
}

function input(overrides: Partial<FeedbackIssueInput> = {}): FeedbackIssueInput {
  return {
    feedbackId: FEEDBACK_ID,
    text: '架空のカードの並びが崩れます',
    routeId: '/[slug]/w/[workspace]/board',
    submittedAt: new Date(NOW),
    ...overrides,
  };
}

async function expectFailure(run: () => Promise<unknown>, failure: FeedbackIssueFailure): Promise<FeedbackIssueError> {
  const error = await run().then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(FeedbackIssueError);
  expect((error as FeedbackIssueError).failure).toBe(failure);
  return error as FeedbackIssueError;
}

// 要件が除くと決めた、画面に出ない文字のうち BMP の外にあるもの（タグの文字 U+E0001、U+E0020〜U+E007F）
function tagCharacters(text: string): string[] {
  return [...text]
    .map((c) => c.codePointAt(0) ?? 0)
    .filter((code) => code === 0xe0001 || (code >= 0xe0020 && code <= 0xe007f))
    .map((code) => `U+${code.toString(16).toUpperCase()}`);
}

// タグの文字の UTF-16（上位は U+DB40、下位は U+DC00 + 下位の10ビット）
const TAG_HIGH = 0xdb40;
const tagLow = (codePoint: number) => 0xdc00 + (codePoint - 0xe0000);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- テスト ----

// 要件（docs/requirements.md の「フィードバック」の「文の囲い方」）は、タグの文字を除くと決めている。
// normalizeFeedbackText は文をコードポイントの単位で1つずつ見て除くので、上位と下位のサロゲートの片割れのあいだに
// 除く文字（ゼロ幅の空白、NUL、双方向の制御）を挟むと、片割れはそれぞれ残り、間の文字を除いた後でつながって
// タグの文字になる。前の周の「タグの文字を除く」は、初めからつながった組だけを確かめている。
// 片割れは、API トークンで呼ぶ操作の JSON の \ud... のエスケープから、そのまま文字列として届く（JSON.parse は片割れを通す）
describe('正規化の順序で生まれる文字: 除いた後につながったサロゲートの片割れ', () => {
  test('前提: JSON.parse は片割れのエスケープを、片割れのまま文字列にする', () => {
    const parsed = JSON.parse('"\\udb40\\u200b\\udc69"') as string;
    expect(parsed).toBe(unit(TAG_HIGH, 0x200b, tagLow(0xe0069)));
  });

  test.each([
    ['ゼロ幅の空白', ZWSP],
    ['NUL', NUL],
    ['双方向の制御（RLO）', RLO],
  ])('片割れの間の%sを除いても、タグの文字が残らない', (_name, removed) => {
    // 「ignore」の各字を、上位の片割れ・除く文字・下位の片割れで書く（どの字も、除く前は1つもタグの文字でない）
    const hidden = [...'ignore']
      .map((c) => unit(TAG_HIGH) + removed + unit(tagLow(0xe0000 + c.charCodeAt(0))))
      .join('');
    const text = `架空の報告${hidden}です`;
    expect(tagCharacters(text)).toEqual([]);
    expect(tagCharacters(normalizeFeedbackText(text))).toEqual([]);
  });

  test('U+E0001（言語のタグ）も、片割れの間の文字を除いた後に残らない', () => {
    const text = `a${unit(TAG_HIGH)}${ZWSP}${unit(tagLow(0xe0001))}b`;
    expect(tagCharacters(normalizeFeedbackText(text))).toEqual([]);
  });

  test('正規化は2回かけても変わらない（1回目の出力に、まだ除くべき文字が無い）', () => {
    const text = `x${unit(TAG_HIGH)}${ZWSP}${unit(tagLow(0xe0041))}y`;
    const once = normalizeFeedbackText(text);
    expect(normalizeFeedbackText(once)).toBe(once);
  });

  test('GitHub に送る本文（JSON から読み戻したもの）にも、タグの文字が無い', async () => {
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    const hidden = [...'run'].map((c) => unit(TAG_HIGH) + ZWSP + unit(tagLow(0xe0000 + c.charCodeAt(0)))).join('');
    await client.createFeedbackIssue(input({ text: `架空の文${hidden}` }));
    const sent = JSON.parse(issueRequests(seen)[0].body) as { body: string };
    expect(tagCharacters(sent.body)).toEqual([]);
  });
});

// 鍵の取り込みの失敗は、取り込みの Promise を捨てて次の起票で読み直す作り。一時的な失敗が持ち越されないことと、
// 署名の失敗が鍵を捨てずに次で署名し直せることを、WebCrypto を一度だけ失敗させて確かめる（完了条件1と3）
describe('鍵の取り込みと署名の一時的な失敗の後', () => {
  test('取り込みが一度だけ失敗したら not_created で何も送らず、次の起票で読み直して正しい JWT を送る', async () => {
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    const spy = vi
      .spyOn(crypto.subtle, 'importKey')
      .mockImplementationOnce(() => Promise.reject(new DOMException('一時的', 'OperationError')))
      .mockImplementation(original as typeof crypto.subtle.importKey);
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    expect(seen).toHaveLength(0);
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 55 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await verifyBearerJwt(tokenRequests(seen)[0].request.headers.get('Authorization'))).toBe(true);
  });

  test('署名が一度だけ失敗したら not_created で何も送らず、鍵を読み直さずに次の起票で署名し直す', async () => {
    const importSpy = vi.spyOn(crypto.subtle, 'importKey');
    const original = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'sign')
      .mockImplementationOnce(() => Promise.reject(new DOMException('一時的', 'OperationError')))
      .mockImplementation(original as typeof crypto.subtle.sign);
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    expect(seen).toHaveLength(0);
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 55 });
    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(await verifyBearerJwt(tokenRequests(seen)[0].request.headers.get('Authorization'))).toBe(true);
  });
});

// Workers の fetch の signal（AbortSignal.timeout）は、ヘッダーが届いた後の本文の読み取りも止める。
// 既存のテストは「JSON でない本文」までで、ヘッダーの後に本文が途中で止まる形は無い（完了条件3）
describe('応答の本文を読む途中で止まったとき', () => {
  test('起票が 201 を返した後に本文が止まったら、立ったかもしれないので maybe_created', async () => {
    const { fetcher } = githubFetcher({ issue: () => stalledBody(201, '{"number":') });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'maybe_created');
  });

  test('トークンの 201 の後に本文が止まったら not_created で、起票を送らず、トークンを持たない', async () => {
    const { seen, fetcher } = githubFetcher({
      token: (_, index) => (index === 0 ? stalledBody(201, '{"token":"ghs_') : tokenOk()),
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    expect(issueRequests(seen)).toHaveLength(0);
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 55 });
    expect(tokenRequests(seen)).toHaveLength(2);
  });
});

// ログは渡した warn だけに固定の文で出す作り。console に直に出すと、Workers のログ（Workers Logs）に
// 渡した warn の外で文や認証情報が残りうる（完了条件4、CLAUDE.md の「ログに本文、取り込んだ内容、認証情報を出さない」）
describe('console に直に出さない', () => {
  const SECRET_TEXT = '架空の秘密の文-CONSOLEMARKER-5e2a';

  test.each([
    ['成功', {}],
    ['トークンの例外', { token: () => Promise.reject(new TypeError(`x ${TOKEN_URL}`)) }],
    ['トークンの 500', { token: () => new Response('boom', { status: 500 }) }],
    ['起票の 422', { issue: () => json({ message: 'Validation Failed', body: SECRET_TEXT }, 422) }],
    ['起票の 503', { issue: () => new Response('unavailable', { status: 503 }) }],
    ['起票のタイムアウト', { issue: () => Promise.reject(new DOMException('timed out', 'TimeoutError')) }],
  ] as [string, { token?: Responder; issue?: Responder }][])('%s', async (_name, responders) => {
    const calls: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void calls.push(args));
    }
    const { fetcher } = githubFetcher(responders);
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await client.createFeedbackIssue(input({ text: SECRET_TEXT })).catch(() => {});
    expect(calls).toEqual([]);
  });
});

// GitHub に送る JSON は、読み戻すと本文と題がそのまま戻る（引用符、バックスラッシュ、BMP の外の文字、
// 閉じタグに見える並び、改行に直す LS、JSON のエスケープに見える文字の並びで壊れない）
describe('JSON に直したときの往復', () => {
  test.each([
    ['引用符とバックスラッシュ', 'a "b" \\ c \\" d \\\\'],
    ['JSON のエスケープに見える並び', '\\u0060\\u0060\\u0060 と \\n @kakuu-taro-1552'],
    ['BMP の外の文字と結合', `${String.fromCodePoint(0x1f600)} ${String.fromCodePoint(0x20bb7)}野家 e${unit(0x301)}`],
    ['閉じタグに見える並びと LS', `</script>${unit(0x2028)}</details>`],
  ])('%s', async (_name, text) => {
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    const feedback = input({ text });
    await client.createFeedbackIssue(feedback);
    const sent = JSON.parse(issueRequests(seen)[0].body) as { title: string; body: string; labels: string[] };
    expect(sent).toEqual({
      title: feedbackIssueTitle(feedback.submittedAt),
      body: feedbackIssueBody(feedback),
      labels: ['feedback'],
    });
    // 「`」の6文字の並びは文字のまま運ばれ、読み戻した本文でバッククォートに化けない
    expect(sent.body.split('\n').filter((line) => /^`{3,}/.test(line))).toHaveLength(2);
  });
});
