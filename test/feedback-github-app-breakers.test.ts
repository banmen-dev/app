// フィードバックの GitHub App の層（src/server/feedback/github-app.ts）を崩す側から確かめるテスト（Issue #1552）。
// test/feedback-github-app.test.ts と重ならない手口だけを置く: 並行した起票とトークンの取得、古いトークンの 401 の競り合い、
// 過去の期限、読まない応答の本文の捨て方、例外の cause、鍵の PEM の形の揺れ、フェンスのタブのインデントと上限いっぱいの文、
// 正規化で取りこぼす画面に出ない文字。
// 鍵はテストの中で作る架空の鍵、トークンと文はすべて架空。見えない文字はソースに直に書かず、番号から作る
import { describe, expect, test } from 'vitest';
import {
  createFeedbackGithubClient,
  feedbackIssueBody,
  FeedbackIssueError,
  normalizeFeedbackText,
  type FeedbackGithubCredentials,
  type FeedbackIssueFailure,
  type FeedbackIssueInput,
} from '../src/server/feedback/github-app.ts';

const APP_ID = '246810';
const INSTALLATION_ID = '1357911';
const TOKEN_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const ISSUES_URL = 'https://api.github.com/repos/banmen-dev/app/issues';
const TOKEN_A = 'ghs_BreakerFakeTokenAAAA0001';
const TOKEN_B = 'ghs_BreakerFakeTokenBBBB0002';
// 2026-11-26 05:10:20 UTC
const NOW = Date.UTC(2026, 10, 26, 5, 10, 20);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const FEEDBACK_ID = '019a8f40-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
const u = (...codes: number[]) => String.fromCodePoint(...codes);

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
  // 鍵の本体の64字ごとの行（BEGIN と END の行を除く）
  const bodyLines = base64(pkcs8).match(/.{1,64}/g) ?? [];
  return { bodyLines, publicKey: pair.publicKey };
})();

const pemOf = (bodyLines: string[], newline = '\n', indent = '') =>
  ['-----BEGIN PRIVATE KEY-----', ...bodyLines.map((l) => indent + l), '-----END PRIVATE KEY-----'].join(newline);

async function credentials(privateKeyPem?: string): Promise<FeedbackGithubCredentials> {
  const { bodyLines } = await keyPair;
  return { appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: privateKeyPem ?? `${pemOf(bodyLines)}\n` };
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

type Seen = { request: Request };
type Responder = (request: Request, index: number) => Response | Promise<Response>;

const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const tokenOk = (token = TOKEN_A, expiresAt = NOW + HOUR) =>
  json({ token, expires_at: new Date(expiresAt).toISOString() }, 201);
const issueOk = (number = 77) => json({ number }, 201);

function githubFetcher(options: { token?: Responder; issue?: Responder } = {}) {
  const seen: Seen[] = [];
  let tokenCount = 0;
  let issueCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({ request });
    if (request.url === TOKEN_URL) return (options.token ?? (() => tokenOk()))(request, tokenCount++);
    if (request.url === ISSUES_URL) return (options.issue ?? (() => issueOk()))(request, issueCount++);
    return new Response('not found', { status: 404 });
  };
  return { seen, fetcher };
}

const tokenRequests = (seen: Seen[]) => seen.filter((s) => s.request.url === TOKEN_URL);
const issueRequests = (seen: Seen[]) => seen.filter((s) => s.request.url === ISSUES_URL);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function input(overrides: Partial<FeedbackIssueInput> = {}): FeedbackIssueInput {
  return {
    feedbackId: FEEDBACK_ID,
    text: '架空のボードで並べ替えが戻ります',
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

// 本文の中の、利用者の文を囲むフェンスの中身（開きは ` の3つ以上に text、閉じは同じ数以上の ` だけの行。インデント3つまで。
// CommonMark ではタブは4桁ぶんのインデントに数えるので、タブで始まる行は閉じにならない）
function fencedContent(body: string): { content: string; closed: boolean; after: string } {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^ {0,3}`{3,}text$/.test(l));
  if (start < 0) throw new Error('フェンスが無い');
  const size = /`+/.exec(lines[start])![0].length;
  for (let i = start + 1; i < lines.length; i++) {
    const close = /^ {0,3}(`+)[ \t]*$/.exec(lines[i]);
    if (close && close[1].length >= size) {
      return { content: lines.slice(start + 1, i).join('\n'), closed: true, after: lines.slice(i + 1).join('\n') };
    }
  }
  return { content: lines.slice(start + 1).join('\n'), closed: false, after: '' };
}

// ---- テスト ----

describe('並行した起票とトークンの状態', () => {
  test('同時に来た初めての起票2つは、トークンの要求を1回だけにし、どちらも同じトークンで立てる', async () => {
    const gate = deferred<void>();
    const { seen, fetcher } = githubFetcher({
      token: async () => {
        await gate.promise;
        return tokenOk();
      },
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    const first = client.createFeedbackIssue(input());
    const second = client.createFeedbackIssue(input());
    // 2つ目が来た後にトークンの応答を返す
    await Promise.resolve();
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([{ issueNumber: 77 }, { issueNumber: 77 }]);
    expect(tokenRequests(seen)).toHaveLength(1);
    expect(issueRequests(seen).map((s) => s.request.headers.get('Authorization'))).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_A}`,
    ]);
  });

  test('同時に待っていたトークンの取得が失敗したら、両方とも not_created で起票を送らず、次の起票で取り直す', async () => {
    const gate = deferred<void>();
    const { seen, fetcher } = githubFetcher({
      token: async (_, index) => {
        if (index === 0) {
          await gate.promise;
          return json({ message: 'boom' }, 500);
        }
        return tokenOk();
      },
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    const first = expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    const second = expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second]);
    expect(issueRequests(seen)).toHaveLength(0);
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 77 });
    expect(tokenRequests(seen)).toHaveLength(2);
  });

  test('古いトークンで送った起票の 401 が、取り直した新しいトークンより後に返っても、新しいトークンを捨てない', async () => {
    let current = NOW;
    const slowIssue = deferred<Response>();
    const { seen, fetcher } = githubFetcher({
      token: (_, index) => (index === 0 ? tokenOk(TOKEN_A, NOW + HOUR) : tokenOk(TOKEN_B, NOW + 3 * HOUR)),
      issue: (request) => (request.headers.get('X-Breaker') === 'slow' ? slowIssue.promise : issueOk()),
    });
    // 遅い起票を見分けるため、1件目だけ印のヘッダーを足す
    let markNext = false;
    const marked: typeof fetch = (url, init) => {
      if (markNext && String(url) === ISSUES_URL) {
        markNext = false;
        const headers = new Headers(init?.headers);
        headers.set('X-Breaker', 'slow');
        return fetcher(url, { ...init, headers });
      }
      return fetcher(url, init);
    };
    const client = createFeedbackGithubClient(await credentials(), marked, { warn: () => {}, now: () => current });
    // TOKEN_A を取って持つ
    await client.createFeedbackIssue(input());
    // TOKEN_A のまま遅い起票を出す
    markNext = true;
    const slow = expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 期限の5分前を過ぎて、TOKEN_B に取り直す
    current = NOW + HOUR - 4 * MINUTE;
    await client.createFeedbackIssue(input());
    // 遅れて TOKEN_A の 401 が返る
    slowIssue.resolve(json({ message: 'Bad credentials' }, 401));
    await slow;
    await client.createFeedbackIssue(input());
    expect(tokenRequests(seen)).toHaveLength(2);
    expect(issueRequests(seen).map((s) => s.request.headers.get('Authorization'))).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
      `Bearer ${TOKEN_B}`,
    ]);
  });

  test('過去の期限（GitHub と時計がずれた）のトークンは持ち続けず、次の起票で取り直す', async () => {
    const { seen, fetcher } = githubFetcher({
      token: (_, index) => tokenOk(index === 0 ? TOKEN_A : TOKEN_B, NOW - MINUTE),
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await client.createFeedbackIssue(input());
    await client.createFeedbackIssue(input());
    expect(tokenRequests(seen)).toHaveLength(2);
    expect(issueRequests(seen).at(-1)?.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN_B}`);
  });
});

describe('読まない応答の本文', () => {
  // cancel されたかを数える本文。終わらない本文にする（読み終えて閉じた本文は、cancel が元に届かないため）
  function trackedBody(text: string) {
    const state = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  test.each([
    ['トークンの 403', 'token', 403],
    ['トークンの 302', 'token', 302],
    ['起票の 422', 'issue', 422],
    ['起票の 503', 'issue', 503],
  ] as const)('%s の本文を読まずに捨てる（接続を持ち続けない）', async (_name, stage, status) => {
    const { stream, state } = trackedBody('{"message":"架空の失敗"}');
    const failing = () => new Response(stream, { status });
    const { fetcher } = githubFetcher(stage === 'token' ? { token: failing } : { issue: failing });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(
      () => client.createFeedbackIssue(input()),
      stage === 'issue' && status >= 500 ? 'maybe_created' : 'not_created',
    );
    expect(state.cancelled).toBe(true);
  });
});

describe('ログとエラーに秘密を出さない: 例外の cause', () => {
  test('fetch の例外の cause に入ったトークンと文を、ログにもエラーにも出さない', async () => {
    const SECRET = '架空の秘密-CAUSEMARKER-5e2a';
    const warnings: string[] = [];
    const { fetcher } = githubFetcher({
      issue: () => Promise.reject(new TypeError('network', { cause: new Error(`${TOKEN_A} ${SECRET}`) })),
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, {
      warn: (message) => void warnings.push(message),
      now: () => NOW,
    });
    const error = await expectFailure(() => client.createFeedbackIssue(input({ text: SECRET })), 'not_created');
    expect(error.cause).toBeUndefined();
    for (const output of [...warnings, error.message, String(error.stack ?? '')]) {
      expect(output).not.toContain(TOKEN_A);
      expect(output).not.toContain('CAUSEMARKER');
    }
  });
});

describe('鍵の PEM の形の揺れ（ダッシュボードに貼ったときに起きうる形）', () => {
  test.each([
    ['CR LF の改行', (lines: string[]) => `${pemOf(lines, '\r\n')}\r\n`],
    ['末尾の改行が無い', (lines: string[]) => pemOf(lines)],
    ['前後の空白と空行', (lines: string[]) => `\n  ${pemOf(lines)}\n\n  `],
    ['行頭のインデント', (lines: string[]) => pemOf(lines, '\n', '  ')],
    ['本体が1行（64字で折らない）', (lines: string[]) => pemOf([lines.join('')])],
  ])('%s でも読み、正しく署名した JWT を送る', async (_name, make) => {
    const { bodyLines } = await keyPair;
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(make(bodyLines)), fetcher, {
      warn: () => {},
      now: () => NOW,
    });
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 77 });
    expect(await verifyBearerJwt(tokenRequests(seen)[0].request.headers.get('Authorization'))).toBe(true);
  });
});

describe('フェンスの外に出ない: 既存のテストに無い形', () => {
  test.each([
    ['タブで字下げした長いバッククォートの行', 'a\n\t`````\n@octocat'],
    ['空白3つとタブの後のバッククォート', 'a\n   \t````\nhttps://example.test'],
    ['終わりがバッククォートで改行が無い', 'https://example.test ```'],
    ['フェンスの開きに見える info string つきの行', '```text\n```js\n````'],
    ['上限いっぱい（5,000 字）のバッククォート', '`'.repeat(5000)],
    ['上限いっぱいの ` と ~ の交互の行', Array.from({ length: 1250 }, (_, i) => (i % 2 ? '~~~' : '```')).join('\n')],
  ])('%s', (_name, text) => {
    const body = feedbackIssueBody(input({ text }));
    const { content, closed, after } = fencedContent(body);
    expect(closed).toBe(true);
    expect(content).toBe(normalizeFeedbackText(text));
    // 閉じの後は、固定の行だけ
    expect(after).toBe(`\n- 送った画面: \`/[slug]/w/[workspace]/board\`\n- フィードバックの ID: ${FEEDBACK_ID}`);
  });
});

// 要件（docs/requirements.md の「フィードバック」の「文の囲い方」）は「制御文字と画面に出ない文字（双方向の制御、ゼロ幅の文字）を除き」。
// 開発のセッションは feedback の Issue の本文を読む（docs/development.md の「Issue の運用」の feedback）ので、
// 人の目に見えず機械には読める文字が残ると、Issue を読む人が見えない文を見落とす。
// 絵文字の見た目を変える異体字セレクタ（U+FE0F など）は、除くと文が変わるので求めない
describe('正規化で除くべき、画面に出ない文字', () => {
  test('タグの文字（U+E0001、U+E0020〜U+E007F）を除く。見えない ASCII の文を運べる', () => {
    // 「ignore」をタグの文字で書いたもの（画面には何も出ない）
    const hidden = u(0xe0001, ...[...'ignore'].map((c) => 0xe0000 + c.charCodeAt(0)), 0xe007f);
    expect(normalizeFeedbackText(`前${hidden}後`)).toBe('前後');
  });

  test('目に見えない演算子（U+2061〜U+2064、ゼロ幅）を除く', () => {
    expect(normalizeFeedbackText(`a${u(0x2061, 0x2062, 0x2063, 0x2064)}b`)).toBe('ab');
  });

  test('モンゴル語の母音の区切り（U+180E、Unicode 6.3 からゼロ幅の書式文字）を除く', () => {
    expect(normalizeFeedbackText(`a${u(0x180e)}b`)).toBe('ab');
  });

  test('使われなくなった書式の文字（U+206A〜U+206F、画面に出ない）を除く', () => {
    expect(normalizeFeedbackText(`a${u(0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f)}b`)).toBe('ab');
  });

  test('断る場合: 異体字セレクタ（絵文字の U+FE0F）は残す', () => {
    const text = `${u(0x2764, 0xfe0f)} 架空の感想`;
    expect(normalizeFeedbackText(text)).toBe(text);
  });
});
