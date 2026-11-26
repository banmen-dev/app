// フィードバックの GitHub App の層（src/server/feedback/github-app.ts）の単体テスト（Issue #1552）。ルートや DB を通さず、層だけを呼ぶ。
// fetch は差し替え、渡された設定から Request を作って Workers の実行環境が受け付けることを確かめる（test/github-method.test.ts と同じ）。
// 秘密鍵はテストの中で crypto.subtle.generateKey で作る架空の鍵で、公開鍵で JWT の署名を検証する。
// 本文がコードブロックの外に出ないことは、CommonMark のフェンスの規則を写した小さな解釈で確かめる（文字列の一致だけに頼らない）。
// 秘密の形の文を断るのは操作（#1553）の入力の検証なので、ここでは確かめない
import { describe, expect, test } from 'vitest';
import {
  createFeedbackGithubClient,
  feedbackGithubCredentials,
  feedbackIssueBody,
  feedbackIssueTitle,
  FeedbackIssueError,
  normalizeFeedbackText,
  type FeedbackGithubCredentials,
  type FeedbackIssueFailure,
  type FeedbackIssueInput,
} from '../src/server/feedback/github-app.ts';

const APP_ID = '123456';
const INSTALLATION_ID = '7654321';
const TOKEN_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const ISSUES_URL = 'https://api.github.com/repos/banmen-dev/app/issues';
// 架空のインストールのトークン
const FAKE_TOKEN = 'ghs_FakeInstallationToken0001';
const FAKE_TOKEN_2 = 'ghs_FakeInstallationToken0002';
// 2026-11-26 03:57:50.123 UTC
const NOW = Date.UTC(2026, 10, 26, 3, 57, 50, 123);
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const ROUTE_ID = '/[slug]/w/[workspace]/board';
// 架空の UUIDv7
const FEEDBACK_ID = '019a8f3e-5c2b-7d41-9e6a-2b3c4d5e6f70';
// 見えない文字はソースに直に書かず、番号から作る（エディタと整形で消えたり化けたりしないように）
const u = (...codes: number[]) => String.fromCodePoint(...codes);
const NEL = u(0x85);
const LS = u(0x2028);
const PS = u(0x2029);
const RLO = u(0x202e);
const ZWSP = u(0x200b);
const ZWJ = u(0x200d);
const WJ = u(0x2060);
const BOM = u(0xfeff);

// ---- 鍵と JWT ----

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

function decodeJsonPart(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

type KeyPair = { pem: string; publicKey: CryptoKey };

async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const lines = base64(pkcs8).match(/.{1,64}/g) ?? [];
  const pem = ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
  return { pem, publicKey: pair.publicKey };
}

// 鍵の組は重いので、ファイルで2つだけ作って使い回す（2つ目は「別の鍵では検証が通らない」ことに使う）
const keyPairs = Promise.all([generateKeyPair(), generateKeyPair()]);

async function credentials(): Promise<FeedbackGithubCredentials> {
  const [{ pem }] = await keyPairs;
  return { appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: pem };
}

// `Bearer <JWT>` を分け、署名を公開鍵で検証する
async function verifyJwt(authorization: string | null, publicKey: CryptoKey) {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
  if (!match) return { valid: false as const };
  const [, header, payload, signature] = match;
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlDecode(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return {
    valid,
    jwt: `${header}.${payload}.${signature}`,
    header: decodeJsonPart(header),
    payload: decodeJsonPart(payload),
  };
}

// ---- fetch の差し替え ----

type Seen = { request: Request; init: RequestInit | undefined; body: string };
type Responder = (request: Request, index: number) => Response | Promise<Response>;

// 受け取った設定から Request を作って控える（Workers の実行環境が設定を受け付けないと、ここで投げる）
function recordingFetcher(respond: Responder) {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    seen.push({ request, init, body });
    return respond(request, seen.length - 1);
  };
  return { seen, fetcher };
}

const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const tokenOk = (token = FAKE_TOKEN, expiresAt = NOW + HOUR) =>
  json({ token, expires_at: new Date(expiresAt).toISOString() }, 201);
const issueOk = (number = 42) => json({ number, html_url: `https://github.com/banmen-dev/app/issues/${number}` }, 201);

// トークンの要求と起票の要求に、それぞれの応答を返す
function githubFetcher(options: { token?: Responder; issue?: Responder } = {}) {
  let tokenCount = 0;
  let issueCount = 0;
  return recordingFetcher((request) => {
    if (request.url === TOKEN_URL) return (options.token ?? (() => tokenOk()))(request, tokenCount++);
    if (request.url === ISSUES_URL) return (options.issue ?? (() => issueOk()))(request, issueCount++);
    return new Response('not found', { status: 404 });
  });
}

function clock(start = NOW) {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

function input(overrides: Partial<FeedbackIssueInput> = {}): FeedbackIssueInput {
  return {
    feedbackId: FEEDBACK_ID,
    text: '架空の画面でボタンが押せません',
    routeId: ROUTE_ID,
    submittedAt: new Date(NOW),
    ...overrides,
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (err: unknown) => err,
  );
}

async function expectFailure(run: () => Promise<unknown>, failure: FeedbackIssueFailure): Promise<FeedbackIssueError> {
  const error = await failureOf(run);
  expect(error).toBeInstanceOf(FeedbackIssueError);
  expect((error as FeedbackIssueError).failure).toBe(failure);
  return error as FeedbackIssueError;
}

const tokenRequests = (seen: Seen[]) => seen.filter((s) => s.request.url === TOKEN_URL);
const issueRequests = (seen: Seen[]) => seen.filter((s) => s.request.url === ISSUES_URL);

// ---- フェンスの解釈（CommonMark の fenced code block の規則を写したもの） ----
// 開き: 行頭のインデント3つまで、` か ~ を3つ以上。` の開きの info string は ` を含まない
// 閉じ: 開きと同じ文字で同じ数以上、行頭のインデント3つまで、後ろは空白とタブだけ
// 中の行は、開きのインデントの数まで行頭の空白を除く。閉じが無ければ文書の終わりまでが中身

type Segment = { kind: 'outside'; lines: string[] } | { kind: 'code'; info: string; lines: string[]; closed: boolean };

function parseFences(markdown: string): Segment[] {
  const lines = markdown.split('\n');
  const segments: Segment[] = [];
  let outside: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open || (open[2][0] === '`' && open[3].includes('`'))) {
      outside.push(lines[i]);
      i++;
      continue;
    }
    if (outside.length > 0) segments.push({ kind: 'outside', lines: outside });
    outside = [];
    const indent = open[1].length;
    const char = open[2][0];
    const size = open[2].length;
    const code: string[] = [];
    let closed = false;
    i++;
    while (i < lines.length) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[i]);
      if (close && close[1][0] === char && close[1].length >= size) {
        closed = true;
        i++;
        break;
      }
      code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
      i++;
    }
    segments.push({ kind: 'code', info: open[3].trim(), lines: code, closed });
  }
  if (outside.length > 0) segments.push({ kind: 'outside', lines: outside });
  return segments;
}

function outsideText(markdown: string): string {
  return parseFences(markdown)
    .filter((s) => s.kind === 'outside')
    .map((s) => s.lines.join('\n'))
    .join('\n<<code>>\n');
}

function codeBlocks(markdown: string) {
  return parseFences(markdown).filter((s): s is Extract<Segment, { kind: 'code' }> => s.kind === 'code');
}

// 本文の決まりを確かめる: コードブロックはちょうど1つで閉じていて、info string は text、中身は正規化した文と同じ。
// 囲いの外は、文が無害なときの本文の囲いの外と1文字も違わない（外に文の一部が出ていない）
function expectContained(text: string, extra: Partial<FeedbackIssueInput> = {}) {
  const body = feedbackIssueBody(input({ text, ...extra }));
  const blocks = codeBlocks(body);
  expect(blocks).toHaveLength(1);
  const [block] = blocks;
  expect(block.closed).toBe(true);
  expect(block.info).toBe('text');
  expect(block.lines.join('\n')).toBe(normalizeFeedbackText(text));
  expect(outsideText(body)).toBe(outsideText(feedbackIssueBody(input({ text: 'x', ...extra }))));
  return body;
}

// 開きのフェンスの行（本文の中で最初に見つかる ` か ~ の3つ以上の行）
function openingFence(body: string): string {
  const line = body.split('\n').find((l) => /^ {0,3}(`{3,}|~{3,})/.test(l));
  if (line === undefined) throw new Error('フェンスが無い');
  return line.trim();
}

// ---- テスト ----

describe('ランタイム（モックを使わない本物の workerd の振る舞い）', () => {
  test('AbortSignal.timeout の reason の名前は TimeoutError で、DOMException は Error の仲間', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe('TimeoutError');
    expect(signal.reason).toBeInstanceOf(Error);
  });

  test('期限の切れた signal の fetch は TimeoutError で投げる（通信の前に止まる）', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    const error = await failureOf(() => fetch(TOKEN_URL, { method: 'POST', signal }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('TimeoutError');
  });

  test('AbortController.abort() の reason の名前は AbortError', () => {
    const controller = new AbortController();
    controller.abort();
    expect((controller.signal.reason as Error).name).toBe('AbortError');
  });

  test('new Request は redirect: manual と signal を受け付け、redirect: error は TypeError で断る', () => {
    const request = new Request(ISSUES_URL, {
      method: 'POST',
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    expect(request.redirect).toBe('manual');
    expect(() => new Request(ISSUES_URL, { redirect: 'error' })).toThrow(TypeError);
  });

  test('PKCS#8 の RSA の鍵を RSASSA-PKCS1-v1_5（SHA-256）で読み込んで署名できる', async () => {
    const [{ pem, publicKey }] = await keyPairs;
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const data = new TextEncoder().encode('a.b');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, data)).toBe(true);
  });

  test('JSON でない応答の res.json() は投げる', async () => {
    await expect(new Response('<html>', { status: 201 }).json()).rejects.toThrow();
  });
});

describe('テストの道具の確かめ', () => {
  test('フェンスの解釈: 短い閉じ、違う文字、4つのインデント、後ろの文字のある行は閉じにならない', () => {
    const body = ['前', '````text', '```', '~~~~', '    ````', '```` x', '````', '後'].join('\n');
    const blocks = codeBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lines).toEqual(['```', '~~~~', '    ````', '```` x']);
    expect(outsideText(body)).toBe('前\n<<code>>\n後');
  });

  test('フェンスの解釈: 中の同じ長さの行で閉じ、閉じが無ければ終わりまでが中身', () => {
    expect(codeBlocks('```\na\n```\nb')[0]).toEqual({ kind: 'code', info: '', lines: ['a'], closed: true });
    expect(codeBlocks('```\na\nb')[0]).toEqual({ kind: 'code', info: '', lines: ['a', 'b'], closed: false });
  });

  test('JWT の検証: 別の鍵と書き換えたペイロードは通らない', async () => {
    const [{ publicKey: other }] = (await keyPairs).slice(1);
    const [{ pem, publicKey }] = await keyPairs;
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const enc = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signing = `${enc({ alg: 'RS256' })}.${enc({ iss: APP_ID })}`;
    const signature = base64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signing)))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect((await verifyJwt(`Bearer ${signing}.${signature}`, publicKey)).valid).toBe(true);
    expect((await verifyJwt(`Bearer ${signing}.${signature}`, other)).valid).toBe(false);
    const tampered = `${enc({ alg: 'RS256' })}.${enc({ iss: '999999' })}`;
    expect((await verifyJwt(`Bearer ${tampered}.${signature}`, publicKey)).valid).toBe(false);
  });
});

describe('feedbackGithubCredentials', () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n';
  const full = {
    FEEDBACK_GITHUB_APP_ID: APP_ID,
    FEEDBACK_GITHUB_INSTALLATION_ID: INSTALLATION_ID,
    FEEDBACK_GITHUB_PRIVATE_KEY: PEM,
  };

  test('3つがそろえば読む（ほかの env の値は無視する）', () => {
    expect(feedbackGithubCredentials({ ...full, GITHUB_CLIENT_ID: 'other' })).toEqual({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPem: PEM,
    });
  });

  test.each(['FEEDBACK_GITHUB_APP_ID', 'FEEDBACK_GITHUB_INSTALLATION_ID', 'FEEDBACK_GITHUB_PRIVATE_KEY'] as const)(
    '%s が無い、空、文字列でないなら undefined',
    (name) => {
      const missing: Record<string, unknown> = { ...full };
      delete missing[name];
      expect(feedbackGithubCredentials(missing)).toBeUndefined();
      expect(feedbackGithubCredentials({ ...full, [name]: '' })).toBeUndefined();
      expect(feedbackGithubCredentials({ ...full, [name]: 123456 })).toBeUndefined();
      expect(feedbackGithubCredentials({ ...full, [name]: undefined })).toBeUndefined();
    },
  );

  test.each(['abc', '12a', ' 123456', '123456 ', '-1', '1.5', '1e5', '０１２３', '0x1F'])(
    'App ID とインストールの ID が10進の数字だけでない %j なら undefined',
    (value) => {
      expect(feedbackGithubCredentials({ ...full, FEEDBACK_GITHUB_APP_ID: value })).toBeUndefined();
      expect(feedbackGithubCredentials({ ...full, FEEDBACK_GITHUB_INSTALLATION_ID: value })).toBeUndefined();
    },
  );
});

describe('完了条件1: JWT の署名とトークンの取得、使い回し、取り直し', () => {
  test('トークンの要求の JWT は RS256 で署名され、iss は App ID、iat は now−60秒、exp は iat から10分以内', async () => {
    const [{ publicKey }] = await keyPairs;
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await client.createFeedbackIssue(input());
    const [tokenRequest] = tokenRequests(seen);
    const jwt = await verifyJwt(tokenRequest.request.headers.get('Authorization'), publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = jwt.payload as { iss: unknown; iat: unknown; exp: unknown };
    const nowSeconds = Math.floor(NOW / 1000);
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(nowSeconds - 60);
    expect(Number.isInteger(payload.exp)).toBe(true);
    expect(payload.exp as number).toBeGreaterThan(nowSeconds);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
  });

  test('断る場合: 別の鍵の公開鍵では、送られた JWT の署名が通らない', async () => {
    const [, { publicKey: other }] = await keyPairs;
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await client.createFeedbackIssue(input());
    const [tokenRequest] = tokenRequests(seen);
    expect((await verifyJwt(tokenRequest.request.headers.get('Authorization'), other)).valid).toBe(false);
  });

  test('トークンの要求の URL、ヘッダー、本文（app だけ、issues: write だけ）', async () => {
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await client.createFeedbackIssue(input());
    expect(seen.map((s) => s.request.url)).toEqual([TOKEN_URL, ISSUES_URL]);
    const [{ request, init, body }] = seen;
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(request.headers.get('Accept')).toBe('application/vnd.github+json');
    expect(request.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(request.headers.get('User-Agent')).toMatch(/\S/);
    expect(JSON.parse(body)).toEqual({ repositories: ['app'], permissions: { issues: 'write' } });
  });

  test('起票の要求の URL、ヘッダー、本文（題、本文、feedback のラベルだけ）と、返す番号', async () => {
    const { seen, fetcher } = githubFetcher({ issue: () => issueOk(1552) });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    const issue = input({ text: '@octocat https://example.test を見て', viewerUrl: null });
    await expect(client.createFeedbackIssue(issue)).resolves.toEqual({ issueNumber: 1552 });
    const [{ request, init, body }] = issueRequests(seen);
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(request.headers.get('Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(request.headers.get('Accept')).toBe('application/vnd.github+json');
    expect(request.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(request.headers.get('User-Agent')).toMatch(/\S/);
    expect(JSON.parse(body)).toEqual({
      title: feedbackIssueTitle(issue.submittedAt),
      body: feedbackIssueBody(issue),
      labels: ['feedback'],
    });
  });

  test('2回目の起票はトークンを使い回し、トークンの要求が増えない', async () => {
    const time = clock();
    const { seen, fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: time.now });
    await client.createFeedbackIssue(input());
    time.set(NOW + 30 * MINUTE);
    await client.createFeedbackIssue(input());
    expect(tokenRequests(seen)).toHaveLength(1);
    expect(issueRequests(seen).map((s) => s.request.headers.get('Authorization'))).toEqual([
      `Bearer ${FAKE_TOKEN}`,
      `Bearer ${FAKE_TOKEN}`,
    ]);
  });

  test('期限の5分前より前なら使い回し、5分前を過ぎたら新しい JWT でトークンを取り直す', async () => {
    const [{ publicKey }] = await keyPairs;
    const time = clock();
    const expiresAt = NOW + HOUR;
    const { seen, fetcher } = githubFetcher({
      token: (_, index) => tokenOk(index === 0 ? FAKE_TOKEN : FAKE_TOKEN_2, index === 0 ? expiresAt : expiresAt + HOUR),
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: time.now });
    await client.createFeedbackIssue(input());
    time.set(expiresAt - 5 * MINUTE - 1000);
    await client.createFeedbackIssue(input());
    expect(tokenRequests(seen)).toHaveLength(1);
    const later = expiresAt - 5 * MINUTE + 1000;
    time.set(later);
    await client.createFeedbackIssue(input());
    const tokens = tokenRequests(seen);
    expect(tokens).toHaveLength(2);
    const jwt = await verifyJwt(tokens[1].request.headers.get('Authorization'), publicKey);
    expect(jwt.valid).toBe(true);
    expect((jwt.payload as { iat: number }).iat).toBe(Math.floor(later / 1000) - 60);
    expect(issueRequests(seen).map((s) => s.request.headers.get('Authorization'))).toEqual([
      `Bearer ${FAKE_TOKEN}`,
      `Bearer ${FAKE_TOKEN}`,
      `Bearer ${FAKE_TOKEN_2}`,
    ]);
  });

  test('起票が 401 を返したら not_created で、次の起票でトークンを取り直す', async () => {
    const { seen, fetcher } = githubFetcher({
      token: (_, index) => tokenOk(index === 0 ? FAKE_TOKEN : FAKE_TOKEN_2),
      issue: (_, index) => (index === 0 ? json({ message: 'Bad credentials' }, 401) : issueOk(7)),
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 7 });
    expect(tokenRequests(seen)).toHaveLength(2);
    expect(issueRequests(seen).at(-1)?.request.headers.get('Authorization')).toBe(`Bearer ${FAKE_TOKEN_2}`);
  });

  test('断る場合: 401 でない失敗（422）ではトークンを捨てず、次の起票で取り直さない', async () => {
    const { seen, fetcher } = githubFetcher({
      issue: (_, index) => (index === 0 ? json({ message: 'Validation Failed' }, 422) : issueOk(8)),
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 8 });
    expect(tokenRequests(seen)).toHaveLength(1);
  });

  test('断る場合: トークンの取得に失敗したら持たず、次の起票でまた取りに行く', async () => {
    const { seen, fetcher } = githubFetcher({
      token: (_, index) => (index === 0 ? json({ message: 'boom' }, 500) : tokenOk()),
    });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 42 });
    expect(tokenRequests(seen)).toHaveLength(2);
  });

  test('断る場合: 別のクライアントはトークンを分け合わない（クライアントの中に持つ）', async () => {
    const { seen, fetcher } = githubFetcher();
    const creds = await credentials();
    await createFeedbackGithubClient(creds, fetcher, { warn: () => {}, now: () => NOW }).createFeedbackIssue(input());
    await createFeedbackGithubClient(creds, fetcher, { warn: () => {}, now: () => NOW }).createFeedbackIssue(input());
    expect(tokenRequests(seen)).toHaveLength(2);
  });
});

describe('題', () => {
  test('「フィードバック YYYY-MM-DD HH:MM:SS UTC」で、ミリ秒を落とす', () => {
    expect(feedbackIssueTitle(new Date(NOW))).toBe('フィードバック 2026-11-26 03:57:50 UTC');
  });

  test('UTC で、桁をゼロで埋める', () => {
    expect(feedbackIssueTitle(new Date('2027-01-05T04:03:09.999+09:00'))).toBe(
      'フィードバック 2027-01-04 19:03:09 UTC',
    );
  });
});

describe('normalizeFeedbackText', () => {
  test('改行（CR LF、CR、NEL、LS、PS）を LF にそろえる', () => {
    expect(normalizeFeedbackText(`a\r\nb\rc${NEL}d${LS}e${PS}f\ng`)).toBe('a\nb\nc\nd\ne\nf\ng');
  });

  test('CR LF は LF 1つになり、2つにならない', () => {
    expect(normalizeFeedbackText('a\r\n\r\nb')).toBe('a\n\nb');
  });

  test('タブと LF を除く C0、DEL、C1 の制御文字を除く', () => {
    const controls = [
      '\u0000',
      '\u0001',
      '\u0007',
      '\u0008',
      '\u000b',
      '\u000c',
      '\u001b',
      '\u001f',
      '\u007f',
      '\u0080',
      '\u009b',
      '\u009f',
    ];
    expect(normalizeFeedbackText(`a${controls.join('')}b\tc\nd`)).toBe('ab\tc\nd');
  });

  test('双方向の制御とゼロ幅の文字を除く', () => {
    const invisible = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c,
      0x200d, 0x2060, 0xfeff,
    ].map((code) => u(code));
    expect(normalizeFeedbackText(`前${invisible.join('')}後`)).toBe('前後');
    for (const char of invisible) expect(normalizeFeedbackText(`x${char}y`)).toBe('xy');
  });

  test('断る場合: ふつうの文字、全角の空白、絵文字、結合文字、前後の空白は変えない', () => {
    const text = `  架空の 株式会社\u3000テスト ${u(0x1f600)} e${u(0x301)} ~~~ \`x\` @a #1  `;
    expect(normalizeFeedbackText(text)).toBe(text);
  });
});

describe('完了条件2: 文はコードブロックの外に出ない', () => {
  test.each([
    ['```', 'a ``` b'],
    ['行頭の ```', '```\n閉じたつもり\n```'],
    ['インデントした ```', '   ```\n  ```'],
    ['```` の連続', 'x ```` y\n`````'],
    ['長いバッククォートの行', '`'.repeat(12)],
    ['~~~', '~~~\n~~~~~~'],
    ['@ のメンション', '@octocat と @banmen-dev/team を呼ぶ'],
    ['URL', 'https://example.test と www.example.test'],
    ['画像', '![x](https://example.test/a.png)'],
    ['リンク', '[ここ](https://example.test) <https://example.test>'],
    ['HTML', '<img src=x onerror=alert(1)>\n<script>x</script>'],
    ['Issue の参照', '#123 と banmen-dev/app#1 と GH-1'],
    ['details の閉じ', '</details>\n</summary>\n<details>'],
    ['見出しと区切り', '# 見出し\n---\n***'],
    ['改行の各種', `a\r\n\`\`\`\rb${NEL}\`\`\`${LS}c${PS}\`\`\``],
    ['制御文字と見えない文字', `\u0000a\u001b[31m${RLO}\`\`\`${ZWSP}${BOM}`],
    ['空行と空白だけの行', '\n\n   \n'],
  ])('%s', (_name, text) => {
    const body = expectContained(text);
    for (const fragment of [
      '@octocat',
      'example.test',
      '#123',
      '<img',
      '![',
      '</details>',
      '<script>',
      '閉じたつもり',
    ]) {
      expect(outsideText(body)).not.toContain(fragment);
    }
  });

  test('フェンスはバッククォートで、文の中で一番長く続くバッククォートより1つ長い（最低3つ）', () => {
    expect(openingFence(feedbackIssueBody(input({ text: 'ふつうの文' })))).toBe('```text');
    expect(openingFence(feedbackIssueBody(input({ text: 'a `b` c' })))).toBe('```text');
    expect(openingFence(feedbackIssueBody(input({ text: 'a ``` b' })))).toBe('````text');
    expect(openingFence(feedbackIssueBody(input({ text: '``` と `````' })))).toBe('``````text');
    expect(openingFence(feedbackIssueBody(input({ text: '~~~~~~' })))).toBe('```text');
  });

  test('見えない文字を除いてつながるバッククォートも数える（正規化の後で数える）', () => {
    // 「`」「ゼロ幅」「``」は正規化すると ``` になる
    expect(openingFence(feedbackIssueBody(input({ text: `\`${ZWSP}\`\`` })))).toBe('````text');
    expectContained(`前\n\`${ZWSP}\`\`\n後`);
    expectContained(`前\r\`${WJ}\`${ZWJ}\`\r後`);
  });

  test('囲いの外には route ID（インラインのコード）とフィードバックの ID を載せる', () => {
    const outside = outsideText(feedbackIssueBody(input()));
    expect(outside).toContain(`\`${ROUTE_ID}\``);
    expect(outside).toContain(FEEDBACK_ID);
  });

  test('断る場合: route ID が null なら載せない', () => {
    const body = feedbackIssueBody(input({ routeId: null, text: 'ふつうの文' }));
    expect(body).not.toContain('[slug]');
    expect(body).not.toContain('board');
    expect(outsideText(body)).toContain(FEEDBACK_ID);
  });

  test('閲覧の口があれば囲いの外に載せ、無ければ載せない', () => {
    const viewerUrl = `https://banmen.example.test/ops/feedback/${FEEDBACK_ID}`;
    expect(outsideText(feedbackIssueBody(input({ viewerUrl })))).toContain(viewerUrl);
    expect(feedbackIssueBody(input({ viewerUrl: null }))).not.toContain('ops/feedback');
    expect(feedbackIssueBody(input({ viewerUrl: undefined }))).not.toContain('ops/feedback');
  });

  test('閲覧の口があっても、文は囲いの外に出ない', () => {
    const viewerUrl = `https://banmen.example.test/ops/feedback/${FEEDBACK_ID}`;
    expectContained('```\n@octocat https://example.test\n```', { viewerUrl });
    expectContained('ふつうの文', { routeId: null, viewerUrl });
  });

  test('囲いの外は文によらず、案内の文を含む（フェンスより外に固定の文がある）', () => {
    const outside = outsideText(feedbackIssueBody(input({ routeId: null })));
    // ID のほかに、利用者の入力であることを示す固定の文がある
    expect(outside.replace(FEEDBACK_ID, '').replace('<<code>>', '').trim().length).toBeGreaterThan(0);
    expect(outsideText(feedbackIssueBody(input({ text: '別の文', routeId: null })))).toBe(outside);
  });
});

describe('完了条件3: 失敗の2つの分類', () => {
  async function failWith(
    responders: { token?: Responder; issue?: Responder },
    failure: FeedbackIssueFailure,
    creds?: FeedbackGithubCredentials,
  ) {
    const { seen, fetcher } = githubFetcher(responders);
    const client = createFeedbackGithubClient(creds ?? (await credentials()), fetcher, {
      warn: () => {},
      now: () => NOW,
    });
    const error = await expectFailure(() => client.createFeedbackIssue(input()), failure);
    return { seen, error };
  }

  describe('トークンの段階はすべて not_created で、起票の要求を送らない', () => {
    test.each([
      ['TypeError で届かない', () => Promise.reject(new TypeError('Network connection lost'))],
      ['TimeoutError', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
      ['AbortError', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
      ['302', () => new Response(null, { status: 302, headers: { Location: 'https://example.test/' } })],
      ['401', () => json({ message: 'A JSON web token could not be decoded' }, 401)],
      ['404', () => json({ message: 'Not Found' }, 404)],
      ['422', () => json({ message: 'Validation Failed' }, 422)],
      ['500', () => json({ message: 'boom' }, 500)],
      ['503', () => new Response('unavailable', { status: 503 })],
      ['201 だが JSON でない', () => new Response('<html>', { status: 201 })],
      ['201 だが token が無い', () => json({ expires_at: new Date(NOW + HOUR).toISOString() }, 201)],
      ['201 だが token が空', () => json({ token: '', expires_at: new Date(NOW + HOUR).toISOString() }, 201)],
      ['201 だが token が文字列でない', () => json({ token: 1, expires_at: new Date(NOW + HOUR).toISOString() }, 201)],
      ['201 だが expires_at が読めない', () => json({ token: FAKE_TOKEN, expires_at: 'あした' }, 201)],
      ['201 だが expires_at が無い', () => json({ token: FAKE_TOKEN }, 201)],
    ] as [string, Responder][])('%s', async (_name, token) => {
      const { seen } = await failWith({ token }, 'not_created');
      expect(issueRequests(seen)).toHaveLength(0);
    });

    test.each([
      ['PEM でない', 'not a key'],
      ['中身の壊れた PEM', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'],
      ['空の PEM', '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n'],
    ])('鍵が読めない（%s）なら not_created で、何も送らない', async (_name, privateKeyPem) => {
      const { seen } = await failWith({}, 'not_created', {
        appId: APP_ID,
        installationId: INSTALLATION_ID,
        privateKeyPem,
      });
      expect(seen).toHaveLength(0);
    });
  });

  describe('起票の段階', () => {
    test.each([
      ['TimeoutError', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
      ['AbortError', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
      ['500', () => json({ message: 'boom' }, 500)],
      ['502', () => new Response('bad gateway', { status: 502 })],
      ['503', () => new Response(null, { status: 503 })],
      ['504', () => new Response(null, { status: 504 })],
      ['201 だが JSON でない', () => new Response('<html>', { status: 201 })],
      ['201 だが number が無い', () => json({ id: 1 }, 201)],
      ['201 だが number が文字列', () => json({ number: '42' }, 201)],
      ['201 だが number が整数でない', () => json({ number: 1.5 }, 201)],
      ['201 だが JSON の null', () => json(null, 201)],
    ] as [string, Responder][])('%s は maybe_created', async (_name, issue) => {
      await failWith({ issue }, 'maybe_created');
    });

    test.each([
      ['TypeError で届かない', () => Promise.reject(new TypeError('Network connection lost'))],
      ['301', () => new Response(null, { status: 301, headers: { Location: 'https://example.test/' } })],
      ['302', () => new Response(null, { status: 302, headers: { Location: 'https://example.test/' } })],
      ['400', () => json({ message: 'Problems parsing JSON' }, 400)],
      ['401', () => json({ message: 'Bad credentials' }, 401)],
      ['403', () => json({ message: 'You have exceeded a secondary rate limit' }, 403)],
      ['404', () => json({ message: 'Not Found' }, 404)],
      ['410', () => json({ message: 'Issues are disabled for this repo' }, 410)],
      ['422', () => json({ message: 'Validation Failed' }, 422)],
      ['429', () => json({ message: 'rate limited' }, 429)],
    ] as [string, Responder][])('%s は not_created', async (_name, issue) => {
      await failWith({ issue }, 'not_created');
    });

    test('断る場合: 200 で number が読めれば成功（201 だけに限らない）', async () => {
      const { fetcher } = githubFetcher({ issue: () => json({ number: 9 }, 200) });
      const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
      await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 9 });
    });

    test('3xx のリダイレクトを追わない（Location の先へ送らない）', async () => {
      const { seen } = await failWith(
        { issue: () => new Response(null, { status: 307, headers: { Location: 'https://example.test/steal' } }) },
        'not_created',
      );
      expect(seen.map((s) => s.request.url)).toEqual([TOKEN_URL, ISSUES_URL]);
    });
  });
});

describe('完了条件4: ログとエラーの message に本文と認証情報を出さない', () => {
  const SECRET_TEXT = '架空の秘密の文-TEXTMARKER-8d1f';
  const RESPONSE_MARKER = 'RESPONSE-BODY-MARKER-3c9a';
  const EXCEPTION_MARKER = 'EXCEPTION-MESSAGE-MARKER-71be';

  // 鍵の PEM の中身を、40字ずつに切った断片（どれか1つでも出れば漏れ）
  async function keyFragments(): Promise<string[]> {
    const [{ pem }] = await keyPairs;
    const base = pem.replace(/-----[^-]+-----|\s/g, '');
    const fragments: string[] = [];
    for (let i = 0; i + 40 <= base.length; i += 40) fragments.push(base.slice(i, i + 40));
    return fragments;
  }

  const scenarios: [string, { token?: Responder; issue?: Responder }][] = [
    ['成功', {}],
    ['トークンの例外', { token: () => Promise.reject(new TypeError(`${EXCEPTION_MARKER} ${TOKEN_URL}`)) }],
    ['トークンの 401', { token: () => json({ message: RESPONSE_MARKER }, 401) }],
    ['トークンの 500', { token: () => new Response(RESPONSE_MARKER, { status: 500 }) }],
    ['トークンの読めない応答', { token: () => new Response(`{${RESPONSE_MARKER}`, { status: 201 }) }],
    ['起票の例外', { issue: () => Promise.reject(new TypeError(`${EXCEPTION_MARKER} ${ISSUES_URL}`)) }],
    ['起票のタイムアウト', { issue: () => Promise.reject(new DOMException(EXCEPTION_MARKER, 'TimeoutError')) }],
    ['起票の 401', { issue: () => json({ message: RESPONSE_MARKER }, 401) }],
    ['起票の 422', { issue: () => json({ message: RESPONSE_MARKER, body: SECRET_TEXT }, 422) }],
    ['起票の 503', { issue: () => new Response(RESPONSE_MARKER, { status: 503 }) }],
    ['起票の読めない応答', { issue: () => new Response(`{${RESPONSE_MARKER}`, { status: 201 }) }],
    ['起票の number の無い応答', { issue: () => json({ message: RESPONSE_MARKER }, 201) }],
  ];

  test.each(scenarios)('%s', async (_name, responders) => {
    const warnings: string[] = [];
    const { seen, fetcher } = githubFetcher(responders);
    const client = createFeedbackGithubClient(await credentials(), fetcher, {
      warn: (message) => void warnings.push(message),
      now: () => NOW,
    });
    const error = await failureOf(() =>
      client.createFeedbackIssue(input({ text: `${SECRET_TEXT}\n@octocat https://example.test` })),
    );
    const jwts = tokenRequests(seen).map((s) => (s.request.headers.get('Authorization') ?? '').replace(/^Bearer /, ''));
    const forbidden = [
      SECRET_TEXT,
      '@octocat',
      'example.test',
      FAKE_TOKEN,
      RESPONSE_MARKER,
      EXCEPTION_MARKER,
      'BEGIN PRIVATE KEY',
      ...jwts.filter((jwt) => jwt !== ''),
      // JWT の部分（ヘッダー、ペイロード、署名）も出さない
      ...jwts.flatMap((jwt) => jwt.split('.')).filter((part) => part.length >= 16),
      ...(await keyFragments()),
    ];
    const outputs = [...warnings];
    if (error !== undefined) {
      expect(error).toBeInstanceOf(FeedbackIssueError);
      outputs.push((error as Error).message, String((error as Error).cause ?? ''));
    }
    for (const output of outputs) {
      for (const secret of forbidden) expect(output).not.toContain(secret);
    }
  });

  test('鍵が読めないときも、鍵の中身を出さない', async () => {
    const warnings: string[] = [];
    const brokenKey = '-----BEGIN PRIVATE KEY-----\nKEYMARKERa1b2c3d4e5f6\n-----END PRIVATE KEY-----\n';
    const { fetcher } = githubFetcher();
    const client = createFeedbackGithubClient(
      { appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: brokenKey },
      fetcher,
      { warn: (message) => void warnings.push(message), now: () => NOW },
    );
    const error = await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    for (const output of [...warnings, error.message, String(error.cause ?? '')]) {
      expect(output).not.toContain('KEYMARKER');
      expect(output).not.toContain('BEGIN PRIVATE KEY');
    }
  });

  test('エラーの message には状態コードを入れる', async () => {
    for (const [status, failure] of [
      [503, 'maybe_created'],
      [422, 'not_created'],
    ] as const) {
      const { fetcher } = githubFetcher({ issue: () => new Response(RESPONSE_MARKER, { status }) });
      const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
      const error = await expectFailure(() => client.createFeedbackIssue(input()), failure);
      expect(error.message).toContain(String(status));
    }
  });

  test('エラーの message には例外の名前を入れ、例外の message を入れない', async () => {
    const { fetcher } = githubFetcher({ issue: () => Promise.reject(new TypeError(EXCEPTION_MARKER)) });
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    const error = await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    expect(error.message).toContain('TypeError');
    expect(error.message).not.toContain(EXCEPTION_MARKER);
  });
});
