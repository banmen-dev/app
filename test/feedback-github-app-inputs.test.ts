// フィードバックの GitHub App の層（src/server/feedback/github-app.ts）が、呼ぶ側から渡る値を本文に載せる前に確かめることのテスト（Issue #1552）。
// 囲いの外に載るフィードバックの ID と閲覧の口の URL、組み立てられない日時、見えない文を運べる異体字セレクタと Default_Ignorable の文字。
// 鍵はテストの中で作る架空の鍵、トークンと文はすべて架空。見えない文字はソースに直に書かず、番号から作る
import { describe, expect, test } from 'vitest';
import {
  createFeedbackGithubClient,
  feedbackIssueBody,
  FeedbackIssueError,
  normalizeFeedbackText,
  type FeedbackGithubCredentials,
  type FeedbackIssueInput,
} from '../src/server/feedback/github-app.ts';

const FEEDBACK_ID = '019a8f41-2b3c-7d4e-8f50-6a7b8c9d0e1f';
const at = (...codes: number[]) => String.fromCodePoint(...codes);

function base64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function credentials(): Promise<FeedbackGithubCredentials> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const lines = base64(pkcs8).match(/.{1,64}/g) ?? [];
  const pem = ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
  return { appId: '864201', installationId: '9753102', privateKeyPem: pem };
}

function input(overrides: Partial<FeedbackIssueInput> = {}): FeedbackIssueInput {
  return {
    feedbackId: FEEDBACK_ID,
    text: '架空の文',
    routeId: '/[slug]/w/[workspace]/board',
    submittedAt: new Date(Date.UTC(2026, 10, 26, 7, 20, 30)),
    ...overrides,
  };
}

// 囲いの後ろ（閉じのフェンスより後）の行
function linesAfterFence(body: string): string[] {
  const lines = body.split('\n');
  const close = lines.lastIndexOf('```');
  return lines.slice(close + 1);
}

describe('組み立てられない入力は、何も送らずに not_created で断る', () => {
  const cases: [string, Partial<FeedbackIssueInput>][] = [
    ['ID に改行とメンション', { feedbackId: `${FEEDBACK_ID}\n@octocat` }],
    ['ID が UUIDv4', { feedbackId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' }],
    ['ID が大文字', { feedbackId: FEEDBACK_ID.toUpperCase() }],
    ['ID が空', { feedbackId: '' }],
    ['不正な日時', { submittedAt: new Date(Number.NaN) }],
  ];
  test.each(cases)('%s', async (_name, overrides) => {
    let requests = 0;
    const warnings: string[] = [];
    const client = createFeedbackGithubClient(
      await credentials(),
      async () => {
        requests += 1;
        return new Response('{}', { status: 500 });
      },
      { warn: (message) => warnings.push(message) },
    );
    const error = await client.createFeedbackIssue(input(overrides)).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(FeedbackIssueError);
    expect((error as FeedbackIssueError).failure).toBe('not_created');
    expect(requests).toBe(0);
    expect(warnings.join('\n')).not.toContain('octocat');
  });

  test('本文の組み立ても ID の形が違えば投げる', () => {
    expect(() => feedbackIssueBody(input({ feedbackId: 'x\n@octocat' }))).toThrow(TypeError);
  });
});

describe('閲覧の口の URL', () => {
  test('https で地の文を壊す文字の無い URL は載る', () => {
    const viewerUrl = `https://banmen.example.test/operator/feedback/${FEEDBACK_ID}`;
    expect(linesAfterFence(feedbackIssueBody(input({ viewerUrl })))).toContain(`- 運用者の閲覧: ${viewerUrl}`);
  });

  const rejected = [
    'x\n\n@octocat [a](http://e)',
    'https://banmen.example.test/operator\n@octocat',
    'http://banmen.example.test/operator/feedback',
    'https://banmen.example.test/operator/feedback?next=@octocat',
    'https://banmen.example.test/operator/(feedback)',
    'https://banmen.example.test/operator/<img>',
    'https://banmen.example.test/operator/feedback#@octocat',
    'javascript:alert(1)',
    'https://user@banmen.example.test/operator',
  ];
  test.each(rejected)('載せない: %j', (viewerUrl) => {
    const after = linesAfterFence(feedbackIssueBody(input({ viewerUrl })));
    expect(after.some((line) => line.startsWith('- 運用者の閲覧'))).toBe(false);
    expect(after.join('\n')).not.toContain('octocat');
  });
});

describe('見えない文を運べる文字を除く', () => {
  const removed: [string, number][] = [
    ['異体字セレクタ U+FE00', 0xfe00],
    ['テキストの見た目のセレクタ U+FE0E', 0xfe0e],
    ['異体字セレクタ補助 U+E0100', 0xe0100],
    ['異体字セレクタ補助 U+E01EF', 0xe01ef],
    ['ハングルの埋め字 U+3164', 0x3164],
    ['ハングルの埋め字 U+FFA0', 0xffa0],
    ['ハングルの埋め字 U+115F', 0x115f],
    ['ソフトハイフン U+00AD', 0x00ad],
    ['CGJ U+034F', 0x034f],
    ['モンゴル語の異体字セレクタ U+180B', 0x180b],
    ['注釈の文字 U+FFF9', 0xfff9],
    ['注釈の文字 U+FFFB', 0xfffb],
    ['楽譜の書式 U+1D173', 0x1d173],
    ['割り当ての無い無視する文字 U+E0080', 0xe0080],
  ];
  test.each(removed)('%s', (_name, code) => {
    expect(normalizeFeedbackText(`a${at(code)}b`)).toBe('ab');
  });

  test('絵文字の後に異体字セレクタを並べて運ぶ文は残らない', () => {
    // 1バイトを U+FE00〜U+FE0F と U+E0100〜U+E01EF に写す手口
    const hidden = [...new TextEncoder().encode('ignore')].map((byte) =>
      at(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16),
    );
    expect(normalizeFeedbackText(`${at(0x1f600)}${hidden.join('')}`)).toBe(at(0x1f600));
  });

  test('絵文字の見た目を決める U+FE0F は残す', () => {
    const heart = `${at(0x2764)}${at(0xfe0f)}`;
    expect(normalizeFeedbackText(heart)).toBe(heart);
  });

  test('ふつうの日本語と絵文字は変わらない', () => {
    const text = `架空の画面で保存できない。${at(0x1f62d)}\n手順: 開く → 保存`;
    expect(normalizeFeedbackText(text)).toBe(text);
  });
});
