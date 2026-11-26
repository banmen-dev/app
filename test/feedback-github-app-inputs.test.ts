// フィードバックの GitHub App の層（src/server/feedback/github-app.ts）が、呼ぶ側から渡る値を本文に載せる前に確かめることのテスト（Issue #1552）。
// 囲いの外に載るフィードバックの ID と閲覧の口の URL、組み立てられない日時、見えない文を運べる異体字セレクタと Default_Ignorable の文字。
// 鍵はテストの中で作る架空の鍵、トークンと文はすべて架空。見えない文字はソースに直に書かず、番号から作る
import { describe, expect, test } from 'vitest';
import {
  createFeedbackGithubClient,
  feedbackGithubCredentials,
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
    ['ID に改行とメンション', { feedbackId: `${FEEDBACK_ID}\n@kakuu-taro-1552` }],
    ['ID が UUIDv4', { feedbackId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' }],
    ['ID が大文字', { feedbackId: FEEDBACK_ID.toUpperCase() }],
    ['ID が空', { feedbackId: '' }],
    ['ID の前にメンション', { feedbackId: `@kakuu-taro-1552\n${FEEDBACK_ID}` }],
    ['ID の前に文字', { feedbackId: `x${FEEDBACK_ID}` }],
    ['ID の variant の桁が c', { feedbackId: '019a8f41-2b3c-7d4e-cf50-6a7b8c9d0e1f' }],
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
    expect(warnings.join('\n')).not.toContain('kakuu-taro-1552');
  });

  test('本文の組み立ても ID の形が違えば投げる', () => {
    expect(() => feedbackIssueBody(input({ feedbackId: 'x\n@kakuu-taro-1552' }))).toThrow(TypeError);
  });
});

describe('閲覧の口の URL', () => {
  test('https で地の文を壊す文字の無い URL は載る', () => {
    const viewerUrl = `https://banmen.example.test/operator/feedback/${FEEDBACK_ID}`;
    expect(linesAfterFence(feedbackIssueBody(input({ viewerUrl })))).toContain(`- 運用者の閲覧: ${viewerUrl}`);
  });

  const rejected = [
    'x\n\n@kakuu-taro-1552 [a](http://e)',
    'https://banmen.example.test/operator\n@kakuu-taro-1552',
    'http://banmen.example.test/operator/feedback',
    'https://banmen.example.test/operator/feedback?next=@kakuu-taro-1552',
    'https://banmen.example.test/operator/(feedback)',
    'https://banmen.example.test/operator/<img>',
    'https://banmen.example.test/operator/feedback#@kakuu-taro-1552',
    'javascript:alert(1)',
    'https://user@banmen.example.test/operator',
    'https://banmen.example.test/operator/a b',
    'https://banmen.example.test/operator/`x`',
    'https://banmen.example.test/operator/[x]',
    'https://banmen.example.test/operator/*x*',
    'https://banmen.example.test/operator/%40x',
    'https://banmen.example.test',
  ];
  test.each(rejected)('載せない: %j', (viewerUrl) => {
    const after = linesAfterFence(feedbackIssueBody(input({ viewerUrl })));
    expect(after.some((line) => line.startsWith('- 運用者の閲覧'))).toBe(false);
    expect(after.join('\n')).not.toContain('kakuu-taro-1552');
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

  test('U+FE0F を並べて運ぶ文は、直前の文字に1つだけ残る', () => {
    const heart = `${at(0x2764)}${at(0xfe0f)}`;
    expect(normalizeFeedbackText(`${heart}${at(0xfe0f).repeat(8)}a`)).toBe(`${heart}a`);
    expect(normalizeFeedbackText(`a${at(0xfe0f).repeat(5)}b${at(0xfe0f).repeat(3)}`)).toBe(
      `a${at(0xfe0f)}b${at(0xfe0f)}`,
    );
  });

  test('文の先頭の U+FE0F と、除いた文字の後に残る U+FE0F の連なりは残らない', () => {
    expect(normalizeFeedbackText(`${at(0xfe0f)}a`)).toBe('a');
    expect(normalizeFeedbackText(`a${at(0xfe0f)}${at(0x200b)}${at(0xfe0f)}`)).toBe(`a${at(0xfe0f)}`);
  });

  test('正規化は2回かけても変わらない（U+FE0F の連なり）', () => {
    const text = `${at(0xfe0f)}x${at(0xfe0f)}${at(0xfe0e)}${at(0xfe0f)}y`;
    const once = normalizeFeedbackText(text);
    expect(normalizeFeedbackText(once)).toBe(once);
  });

  test('漢字の異体字の指定（IVS）は除き、基本の字は残す', () => {
    expect(normalizeFeedbackText(`${at(0x845b)}${at(0xe0100)}`)).toBe(at(0x845b));
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

describe('route ID', () => {
  test.each(['/[slug]/w/[workspace]/board', '/~', '/'])('載る: %j', (routeId) => {
    expect(linesAfterFence(feedbackIssueBody(input({ routeId })))).toContain(`- 送った画面: \`${routeId}\``);
  });

  test.each(['/x`@kakuu-taro-1552`', '/a b', '/a\n@kakuu-taro-1552', '', `/a${at(0x200b)}`, '/日本語'])(
    '載せない: %j',
    (routeId) => {
      const after = linesAfterFence(feedbackIssueBody(input({ routeId })));
      expect(after.some((line) => line.startsWith('- 送った画面'))).toBe(false);
      expect(after.join('\n')).not.toContain('kakuu-taro-1552');
    },
  );

  test('null なら行が無く、null の文字も出ない', () => {
    const after = linesAfterFence(feedbackIssueBody(input({ routeId: null })));
    expect(after.some((line) => line.startsWith('- 送った画面'))).toBe(false);
    expect(after.join('\n')).not.toContain('null');
  });
});

describe('対にならないサロゲートの境界', () => {
  test.each([0xd800, 0xdbff, 0xdc00, 0xdfff])('U+%s の片割れを除く', (code) => {
    expect(normalizeFeedbackText(`a${String.fromCharCode(code)}b`)).toBe('ab');
  });
});

describe('鍵の形', () => {
  const env = (key: string) => ({
    FEEDBACK_GITHUB_APP_ID: '864201',
    FEEDBACK_GITHUB_INSTALLATION_ID: '9753102',
    FEEDBACK_GITHUB_PRIVATE_KEY: key,
  });
  test.each([
    '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIfake\n-----END ENCRYPTED PRIVATE KEY-----\n',
    '   ',
    // 改行が文字の \n のまま1行で入った鍵（ダッシュボードに貼ると起きやすい）
    '-----BEGIN PRIVATE KEY-----\\nMIIfake\\n-----END PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----\n',
    '-----BEGIN PRIVATE KEY-----\nMII*fake!\n-----END PRIVATE KEY-----\n',
  ])('PKCS#8 の PEM でなければ設定が無いものとして扱う: %j', (key) => {
    expect(feedbackGithubCredentials(env(key))).toBeUndefined();
  });
});

describe('トークンの期限の境界と応答の型', () => {
  const NOW = Date.UTC(2026, 10, 26, 7, 20, 30);
  const MARGIN = 5 * 60 * 1000;

  function fetcherWith(tokenBody: () => unknown) {
    const counts = { token: 0, issue: 0 };
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith('/access_tokens')) {
        counts.token += 1;
        return new Response(JSON.stringify(tokenBody()), { status: 201 });
      }
      counts.issue += 1;
      return new Response(JSON.stringify({ number: 42 }), { status: 201 });
    };
    return { counts, fetcher };
  }

  test('期限の5分前の1ミリ秒前までは使い回し、5分前ちょうどで取り直す', async () => {
    const expiresAt = NOW + 60 * 60 * 1000;
    const { counts, fetcher } = fetcherWith(() => ({
      token: 'ghs_FakeBoundaryToken',
      expires_at: new Date(expiresAt).toISOString(),
    }));
    let now = NOW;
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => now });
    await client.createFeedbackIssue(input());
    now = expiresAt - MARGIN - 1;
    await client.createFeedbackIssue(input());
    expect(counts.token).toBe(1);
    now = expiresAt - MARGIN;
    await client.createFeedbackIssue(input());
    expect(counts.token).toBe(2);
    expect(counts.issue).toBe(3);
  });

  test('expires_at が数なら not_created で、起票を送らない', async () => {
    const { counts, fetcher } = fetcherWith(() => ({ token: 'ghs_FakeBoundaryToken', expires_at: 1234 }));
    const client = createFeedbackGithubClient(await credentials(), fetcher, { warn: () => {}, now: () => NOW });
    const error = await client.createFeedbackIssue(input()).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect((error as FeedbackIssueError).failure).toBe('not_created');
    expect(counts.issue).toBe(0);
  });
});
