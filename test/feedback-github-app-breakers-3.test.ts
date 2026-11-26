// フィードバックの GitHub App の層（src/server/feedback/github-app.ts）を崩す側から確かめるテストの3周目（Issue #1552）。
// test/feedback-github-app.test.ts、test/feedback-github-app-breakers.test.ts、test/feedback-github-app-breakers-2.test.ts と
// 重ならない手口だけを置く:
// - 本文を、テストの手書きのフェンスの解釈ではなく、本物の CommonMark と GFM の解析器（micromark、画面の Markdown と同じもの）で
//   読み、決まった種で作った崩しの文を数多く流して、文がコードブロックの外に出ないことを確かめる
// - 前の周は TimeoutError をモックの fetch が直に投げていた。ここでは実装が作った signal そのものが切れたときに、
//   signal に従う fetch（本物の fetch と同じく signal.reason で投げる）で分類が合うことと、要求ごとに別の時限を持つことを確かめる
// - 本物の workerd の fetch を、包まずにそのまま渡しても呼べる（this を失って Illegal invocation にならない）こと
// 鍵はテストの中で作る架空の鍵、トークンと文はすべて架空。見えない文字はソースに直に書かず、番号から作る
import type { Code, Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createFeedbackGithubClient,
  feedbackIssueBody,
  FeedbackIssueError,
  normalizeFeedbackText,
  type FeedbackGithubCredentials,
  type FeedbackIssueFailure,
  type FeedbackIssueInput,
} from '../src/server/feedback/github-app.ts';

const APP_ID = '531864';
const INSTALLATION_ID = '2468013';
const TOKEN_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const ISSUES_URL = 'https://api.github.com/repos/banmen-dev/app/issues';
const TOKEN = 'ghs_ThirdBreakerFakeToken0004';
// 2026-11-26 09:41:12 UTC
const NOW = Date.UTC(2026, 10, 26, 9, 41, 12);
const HOUR = 60 * 60 * 1000;
const FEEDBACK_ID = '019a9a12-3c4d-7e5f-8a6b-7c8d9e0f1a2b';
const ROUTE_ID = '/[slug]/w/[workspace]/board';
const VIEWER_URL = `https://banmen.example.test/ops/feedback/${FEEDBACK_ID}`;
const SECRET_TEXT = '架空の秘密の文 ghp_FakeThirdBreaker0000';
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

// ---- 鍵 ----

function base64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const keyPem = (async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const lines = base64(pkcs8).match(/.{1,64}/g) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
})();

async function credentials(): Promise<FeedbackGithubCredentials> {
  return { appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: await keyPem };
}

function input(overrides: Partial<FeedbackIssueInput> = {}): FeedbackIssueInput {
  return {
    feedbackId: FEEDBACK_ID,
    text: '架空のボードの列が重なります',
    routeId: ROUTE_ID,
    submittedAt: new Date(NOW),
    ...overrides,
  };
}

const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const tokenOk = () => json({ token: TOKEN, expires_at: new Date(NOW + HOUR).toISOString() }, 201);

async function expectFailure(run: () => Promise<unknown>, failure: FeedbackIssueFailure): Promise<FeedbackIssueError> {
  const error = await run().then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(FeedbackIssueError);
  expect((error as FeedbackIssueError).failure).toBe(failure);
  return error as FeedbackIssueError;
}

// ---- 本物の Markdown の解析 ----

// GitHub の Issue の描き方（CommonMark と GFM）に近い解析。メンションと Issue の参照は GitHub が文の節だけに付けるので、
// 「コードの節の外の文の節に、利用者の文が無い」ことで代わりに確かめる
function parse(body: string): Root {
  return fromMarkdown(body, {
    extensions: [gfmAutolinkLiteral(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
    mdastExtensions: [
      gfmAutolinkLiteralFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
    ],
  });
}

function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ('children' in node) for (const child of node.children) walk(child as Nodes, visit);
}

type Shape = { codes: Code[]; links: string[]; kinds: Set<string>; outsideText: string };

function shapeOf(body: string): Shape {
  const codes: Code[] = [];
  const links: string[] = [];
  const kinds = new Set<string>();
  const outside: string[] = [];
  walk(parse(body), (node) => {
    kinds.add(node.type);
    if (node.type === 'code') codes.push(node);
    if (node.type === 'link') links.push(node.url);
    if (node.type === 'text' || node.type === 'inlineCode') outside.push(node.value);
  });
  return { codes, links, kinds, outsideText: outside.join('\n') };
}

// 文に依らない、ふつうの文での本文の形（コードブロックの外の節の種類と文）
function baseline(overrides: Partial<FeedbackIssueInput>): Shape {
  return shapeOf(feedbackIssueBody(input({ text: 'ふつうの文', ...overrides })));
}

function expectContainedByParser(text: string, overrides: Partial<FeedbackIssueInput> = {}): void {
  const shape = shapeOf(feedbackIssueBody(input({ text, ...overrides })));
  const base = baseline(overrides);
  // コードブロックはちょうど1つで、中身は正規化した文そのもの、言語は text で、info string に文が漏れない
  expect(shape.codes).toHaveLength(1);
  expect(shape.codes[0].value).toBe(normalizeFeedbackText(text));
  expect(shape.codes[0].lang).toBe('text');
  expect(shape.codes[0].meta ?? null).toBeNull();
  // 外の節の種類、リンク、文は、ふつうの文のときと同じ（利用者の文で増えない）
  expect([...shape.kinds].sort()).toEqual([...base.kinds].sort());
  expect(shape.links).toEqual(base.links);
  expect(shape.outsideText).toBe(base.outsideText);
}

// 決まった種の擬似乱数（xorshift32）。落ちたときに同じ文を作り直せる
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

// 崩しに使う部品: フェンス、インデント、改行の各種、見えない文字、メンション、URL、HTML、表、引用、リスト
const PIECES = [
  '`',
  '``',
  '```',
  '````',
  '~~~',
  '\n',
  '\r\n',
  '\r',
  cp(0x85),
  cp(0x2028),
  cp(0x2029),
  ' ',
  '   ',
  '    ',
  '\t',
  '>',
  '> ',
  '- ',
  '1. ',
  '* [ ] ',
  '|',
  '| a | b |\n| - | - |',
  '---',
  '#',
  '#12',
  '@octocat',
  '@banmen-dev/team',
  'https://example.test/x',
  'www.example.test',
  'mail@example.test',
  '[a](https://example.test)',
  '![b](https://example.test/b.png)',
  '<https://example.test>',
  '<details>',
  '</details>',
  '<!--',
  '-->',
  '\\',
  '&#96;',
  '&lt;',
  'text',
  '架空',
  cp(0x200b),
  cp(0x200d),
  cp(0x2060),
  cp(0xfeff),
  cp(0x202e),
  cp(0x0000),
  cp(0x001b),
  cp(0xe0041),
  cp(0x1f600),
  cp(0xfe0f),
];

function randomText(next: () => number): string {
  const length = 1 + Math.floor(next() * 40);
  let text = '';
  for (let i = 0; i < length; i++) text += PIECES[Math.floor(next() * PIECES.length)];
  return text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- テスト ----

// 完了条件2「文に ``` や @ や URL を含めても、本文でコードブロックの外に出ず、通知やリンクにならない」。
// 前の周はテストの中の手書きのフェンスの解釈で確かめていた。手書きの解釈が CommonMark とずれていれば、両方が同じ所を見落とす。
// ここでは画面の Markdown と同じ解析器（micromark と GFM の拡張）で読む
describe('本物の CommonMark と GFM の解析器で読んでも、文はコードブロックの外に出ない', () => {
  test('前提: 解析器は、閉じていないフェンスを文の終わりまでのコードにし、外のリンクとメンションの形を文の節にする', () => {
    const shape = shapeOf('前 @octocat https://example.test\n\n```text\n中\n');
    expect(shape.codes.map((c) => c.value)).toEqual(['中']);
    expect(shape.links).toEqual(['https://example.test']);
    expect(shape.outsideText).toContain('@octocat');
  });

  test.each([
    ['閉じのフェンスより長いバッククォートの行', 'a\n`````\n@octocat'],
    ['チルダの長い行の後のバッククォート', '~~~~~~~~\n```\nhttps://example.test'],
    ['表の形の行', '| @octocat | https://example.test |\n| --- | --- |\n| ``` | x |'],
    ['引用とリストの中のフェンス', '> ```\n> @octocat\n- ```\n  https://example.test'],
    ['HTML のコメントの開き', '<!-- \n```\n@octocat'],
    ['文字参照のバッククォート', '&#96;&#96;&#96;\n@octocat'],
    ['バックスラッシュでのエスケープ', '\\```\n\\@octocat https://example.test'],
    ['info string に見える行で始まる', 'text @octocat\n```text @octocat'],
    ['空の文（正規化で全部消える）', `${cp(0x200b)}${cp(0x0000)}${cp(0x202e)}`],
  ])('%s', (_name, text) => {
    expectContainedByParser(text);
    expectContainedByParser(text, { routeId: null });
    expectContainedByParser(text, { viewerUrl: VIEWER_URL });
  });

  test('決まった種で作った崩しの文 600 件', () => {
    const next = rng(0x1552);
    for (let i = 0; i < 600; i++) {
      const text = randomText(next);
      const overrides: Partial<FeedbackIssueInput> =
        i % 3 === 0 ? {} : i % 3 === 1 ? { routeId: null } : { viewerUrl: VIEWER_URL };
      try {
        expectContainedByParser(text, overrides);
      } catch (error) {
        throw new Error(`${i} 件目の文 ${JSON.stringify(text)} で崩れた`, { cause: error });
      }
    }
  });
});

// docs/requirements.md の「フィードバック」と Issue の「やること」: AbortSignal.timeout を付け、起票のタイムアウトは maybe_created、
// トークンの段階は not_created。前の周はモックの fetch が TimeoutError を直に投げていたので、実装が作った signal が
// 本当に要求に渡り、それが切れたときに分類が合うかは確かめていない。
// AbortSignal.timeout を短い時限に差し替え、signal に従う fetch（切れたら signal.reason で投げる。本物の fetch と同じ）で確かめる
describe('実装が作った時限の signal が切れたとき', () => {
  // 実装が求めた時限を記録し、実際は短い時限の signal を返す
  function shortenTimeouts(): number[] {
    const requested: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      requested.push(ms);
      return original(5);
    });
    return requested;
  }

  // signal が切れるまで応答しない（切れたら reason で投げる）
  function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  test('起票の要求が応答しないまま時限が切れたら maybe_created で、トークンと起票はそれぞれ 10 秒の時限を持つ', async () => {
    const requested = shortenTimeouts();
    const urls: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url) === TOKEN_URL) return tokenOk();
      return hangUntilAborted(init?.signal);
    };
    const warnings: string[] = [];
    const client = createFeedbackGithubClient(await credentials(), fetcher, {
      warn: (message) => void warnings.push(message),
      now: () => NOW,
    });
    const error = await expectFailure(() => client.createFeedbackIssue(input({ text: SECRET_TEXT })), 'maybe_created');
    expect(urls).toEqual([TOKEN_URL, ISSUES_URL]);
    // 要求ごとに新しい時限（トークンの取得で使った時間が、起票の時限を削らない）
    expect(requested).toEqual([10_000, 10_000]);
    expect(error.message).toContain('TimeoutError');
    for (const output of [...warnings, error.message]) {
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain('ghp_');
    }
  });

  test('トークンの要求が応答しないまま時限が切れたら not_created で、起票を送らない', async () => {
    shortenTimeouts();
    const urls: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(String(url));
      return hangUntilAborted(init?.signal);
    };
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    expect(urls).toEqual([TOKEN_URL]);
  });

  test('時限の切れた後の起票は、トークンを使い回し、新しい時限で送り直せる', async () => {
    const requested = shortenTimeouts();
    let issueCalls = 0;
    let tokenCalls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url) === TOKEN_URL) {
        tokenCalls++;
        return tokenOk();
      }
      issueCalls++;
      if (issueCalls === 1) return hangUntilAborted(init?.signal);
      // 2回目に渡る signal は、まだ切れていない新しいもの
      expect(init?.signal?.aborted).toBe(false);
      return json({ number: 31 }, 201);
    };
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    await expectFailure(() => client.createFeedbackIssue(input()), 'maybe_created');
    await expect(client.createFeedbackIssue(input())).resolves.toEqual({ issueNumber: 31 });
    expect(tokenCalls).toBe(1);
    expect(requested).toEqual([10_000, 10_000, 10_000]);
  });
});

// 本番では呼ぶ側（#1553）が Workers の fetch をそのまま渡す。workerd の fetch は、オブジェクトの持ち物として呼ぶ（`o.f(url)`）と
// this が違って Illegal invocation の TypeError で投げる（この周に手元の workerd で確かめた。素の関数として呼べば投げない）。
// 実装が fetcher を options などに入れて呼ぶ形に変わると、TypeError は「届かない」と同じ名前なので、
// 起きれば毎回 not_created になり、気づけない。ここでは通信の前に止まるよう、切れた signal を返させて確かめる
describe('本物の workerd の fetch をそのまま渡す', () => {
  test('包まずに渡した fetch が呼べ、切れた signal の TimeoutError で not_created になる（TypeError にならない）', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('架空の時限切れ', 'TimeoutError')),
    );
    const warnings: string[] = [];
    const client = createFeedbackGithubClient(await credentials(), fetch, {
      warn: (message) => void warnings.push(message),
      now: () => NOW,
    });
    const error = await expectFailure(() => client.createFeedbackIssue(input()), 'not_created');
    expect(error.message).toContain('TimeoutError');
    expect(error.message).not.toContain('TypeError');
    expect(warnings).toEqual([error.message]);
  });
});
