// フィードバックの画像とメタ情報の R2 への置き方と、Issue に載せる閲覧の口（Issue #1556）。
// 画像の形式、枚数、大きさの検査、起票の結果ごとの R2 の扱い、Issue の本文に載るものを確かめる
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { feedbackSubmit } from '../src/shared/operations/feedback.ts';
import {
  apngImage,
  ascii,
  concatBytes,
  filler,
  gifImage,
  jpegImage,
  pngImage,
  svgImage,
  webpAnimated,
  webpLossless,
  webpLossy,
} from './avatar-images.ts';
import { fakeFeedbackGithubEnv, fakeFeedbackGithubResponse, FEEDBACK_ISSUES_URL } from './feedback/fake-github-app.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const MIB = 1024 * 1024;
const BOARD_ROUTE_ID = '/[slug]/w/[id]/board';
const BOARD_PATH = '/test-private-org/w/test-private-workspace/board';
const input = {
  text: '画面の見出しが切れています',
  route_id: BOARD_ROUTE_ID,
  url: new URL(`${BOARD_PATH}?source=private-query#private-fragment`, testEnv.PUBLIC_ORIGIN).href,
};

let githubEnv: Env;

beforeAll(async () => {
  githubEnv = await fakeFeedbackGithubEnv(testEnv);
});

async function clearObjects(env: Env) {
  const { objects } = await env.ATTACHMENTS.list({ prefix: 'feedback/' });
  if (objects.length > 0) await env.ATTACHMENTS.delete(objects.map((object) => object.key));
}

beforeEach(async () => {
  const db = commonDb(testEnv);
  await db.run(db.statement((q) => q.deleteFrom('rate_limits').where('key', '=', 'feedback:global')));
  await clearObjects(testEnv);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function objectKeys(): Promise<string[]> {
  return (await testEnv.ATTACHMENTS.list({ prefix: 'feedback/' })).objects.map((object) => object.key).sort();
}

type GithubIssue = { title: string; body: string; labels: string[] };

function fakeGithub(issueResponse?: () => Response | Promise<Response>) {
  const issues: GithubIssue[] = [];
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (requestInput, init) => {
    const request = new Request(requestInput, init);
    requests.push(request);
    if (request.url === FEEDBACK_ISSUES_URL && request.method === 'POST') {
      issues.push(await request.clone().json());
      if (issueResponse) return issueResponse();
    }
    const response = fakeFeedbackGithubResponse(request);
    if (response) return response;
    throw new Error('想定外のフィードバックの送信先');
  };
  return { app: createApp(undefined, { fetcher }), issues, requests };
}

function image(bytes: Uint8Array, name = 'screen.png', type = 'image/png'): File {
  return new File([bytes], name, { type });
}

function submit(
  app: ReturnType<typeof createApp>,
  person: Person,
  files: readonly File[] = [],
  body: unknown = input,
  env: Env = githubEnv,
) {
  return post(app, feedbackSubmit, { env, token: person.token, body, files });
}

async function expectImageError(res: Response, message: string) {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'invalid_input',
      message: 'invalid input',
      details: [{ path: 'files', code: 'custom', message }],
    },
  });
}

test('PNG、JPEG、WebP を3枚まで受け、画像ごとと meta.json を R2 に置いてから Issue を立てる', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();
  const png = pngImage(640, 480);
  const jpeg = jpegImage(800, 600);
  const webp = webpLossless(320, 200);

  const res = await submit(app, person, [
    // 申告の名前と種類は使わない
    image(png, 'a.html', 'text/html'),
    image(jpeg, 'b.svg', 'image/svg+xml'),
    image(webp, 'c', 'application/octet-stream'),
  ]);

  expect(res.status).toBe(200);
  const { feedback_id } = await res.json<{ feedback_id: string }>();
  const keys = await objectKeys();
  expect(keys).toHaveLength(4);
  expect(keys).toContain(`feedback/${feedback_id}/meta.json`);
  expect(keys.every((key) => key.startsWith(`feedback/${feedback_id}/`))).toBe(true);

  const meta = await (await testEnv.ATTACHMENTS.get(`feedback/${feedback_id}/meta.json`))!.json<{
    feedback_id: string;
    account_id: string;
    url: string;
    route_id: string;
    text: string;
    images: { id: string; content_type: string; bytes: number }[];
    submitted_at: string;
  }>();
  expect(meta).toMatchObject({
    feedback_id,
    account_id: person.accountId,
    url: new URL(BOARD_PATH, testEnv.PUBLIC_ORIGIN).href,
    route_id: BOARD_ROUTE_ID,
    text: input.text,
  });
  expect(Number.isNaN(Date.parse(meta.submitted_at))).toBe(false);
  expect(meta.images.map((entry) => [entry.content_type, entry.bytes])).toEqual([
    ['image/png', png.byteLength],
    ['image/jpeg', jpeg.byteLength],
    ['image/webp', webp.byteLength],
  ]);
  for (const [index, bytes] of [png, jpeg, webp].entries()) {
    const object = await testEnv.ATTACHMENTS.get(`feedback/${feedback_id}/${meta.images[index]!.id}`);
    expect(object?.httpMetadata?.contentType).toBe(meta.images[index]!.content_type);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
  }

  expect(issues).toHaveLength(1);
});

test('画像が無くても meta.json を置く', async () => {
  const person = await createPerson();
  const { app } = fakeGithub();

  const res = await submit(app, person);

  expect(res.status).toBe(200);
  const { feedback_id } = await res.json<{ feedback_id: string }>();
  expect(await objectKeys()).toEqual([`feedback/${feedback_id}/meta.json`]);
});

test('Issue の本文には閲覧の口のリンクを1本だけ載せ、完全な URL、画像、アカウントの ID は載せない', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();

  const res = await submit(app, person, [image(pngImage(64, 64))]);

  expect(res.status).toBe(200);
  const { feedback_id } = await res.json<{ feedback_id: string }>();
  const body = issues[0]!.body;
  const viewerUrl = `${new URL(testEnv.PUBLIC_ORIGIN).origin}/operator/feedback/${feedback_id}`;
  expect(body.split(viewerUrl)).toHaveLength(2);
  expect(body.match(/https?:\/\//g)).toHaveLength(1);
  const keys = await objectKeys();
  const imageId = keys.find((key) => !key.endsWith('meta.json'))!.split('/')[2]!;
  for (const hidden of [
    input.url,
    BOARD_PATH,
    'private-query',
    'private-fragment',
    person.accountId,
    imageId,
    '![',
    'screen.png',
  ]) {
    expect(body).not.toContain(hidden);
  }
});

test('PUBLIC_ORIGIN が https でなく閲覧の口の URL を作れなければ、固定の文で警告し、Issue は立てる', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();
  const env = { ...githubEnv, PUBLIC_ORIGIN: 'http://localhost:5173' } as unknown as Env;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const res = await submit(app, person, [], { ...input, url: 'http://localhost:5173/' }, env);

  expect(res.status).toBe(200);
  expect(issues[0]!.body).not.toContain('/operator/feedback/');
  expect(warn).toHaveBeenCalledWith('フィードバックの閲覧の口の URL を作れなかった（PUBLIC_ORIGIN の形）');
});

test.each([
  ['招待の画面', '/invite/secret-token'],
  ['招待の画面（大文字）', '/Invite/secret-token'],
  ['認証の画面', '/auth/callback'],
  ['パーセントエンコードした招待の画面', '/%69nvite/secret-token'],
  ['先頭にスラッシュが重なった招待の画面', '//invite/secret-token'],
])('%s からの送信では URL を残さない', async (_label, path) => {
  const person = await createPerson();
  const { app } = fakeGithub();

  const res = await submit(app, person, [], { ...input, url: `${new URL(testEnv.PUBLIC_ORIGIN).origin}${path}` });

  expect(res.status).toBe(200);
  const { feedback_id } = await res.json<{ feedback_id: string }>();
  const meta = await (await testEnv.ATTACHMENTS.get(`feedback/${feedback_id}/meta.json`))!.json<{ url: unknown }>();
  expect(meta.url).toBeNull();
  expect(JSON.stringify(meta)).not.toContain('secret-token');
});

test('slug が invite や auth で始まるだけの組織の画面の URL は残す', async () => {
  const person = await createPerson();
  const { app } = fakeGithub();
  const url = new URL('/invitecorp/w/x/board?q=1', testEnv.PUBLIC_ORIGIN).href;

  const res = await submit(app, person, [], { ...input, url });

  const { feedback_id } = await res.json<{ feedback_id: string }>();
  const meta = await (await testEnv.ATTACHMENTS.get(`feedback/${feedback_id}/meta.json`))!.json<{ url: string }>();
  expect(meta.url).toBe(new URL('/invitecorp/w/x/board', testEnv.PUBLIC_ORIGIN).href);
});

test('meta.json の文は、Issue に載せるのと同じく正規化したもの', async () => {
  const person = await createPerson();
  const { app } = fakeGithub();

  const res = await submit(app, person, [], { ...input, text: 'a\u200Bb\r\nc' });

  const { feedback_id } = await res.json<{ feedback_id: string }>();
  const meta = await (await testEnv.ATTACHMENTS.get(`feedback/${feedback_id}/meta.json`))!.json<{ text: string }>();
  expect(meta.text).toBe('ab\nc');
});

test('4MiB ちょうどの画像を3枚送ると通り、4つのファイルを置く（本文の上限に収まる）', async () => {
  const person = await createPerson();
  const { app } = fakeGithub();
  const files = Array.from({ length: 3 }, () => image(pngImage(8, 8, { totalBytes: 4 * MIB })));

  const res = await submit(app, person, files);

  expect(res.status).toBe(200);
  expect(await objectKeys()).toHaveLength(4);
});

const rejected: [string, () => File[], string][] = [
  ['4枚', () => Array.from({ length: 4 }, () => image(pngImage(8, 8))), 'too_many_images'],
  ['4MiB を超える PNG', () => [image(pngImage(8, 8, { totalBytes: 4 * MIB + 1 }))], 'image_too_large'],
  ['一辺が 8,193px の PNG', () => [image(pngImage(8193, 8))], 'image_too_large'],
  ['一辺が 8,193px の JPEG', () => [image(jpegImage(8, 8193), 'a.jpg', 'image/jpeg')], 'image_too_large'],
  ['一辺が 8,193px の WebP', () => [image(webpLossy(8193, 8), 'a.webp', 'image/webp')], 'image_too_large'],
  ['GIF', () => [image(gifImage(8, 8), 'a.png', 'image/png')], 'image_unsupported'],
  ['SVG を PNG の名前と種類で', () => [image(svgImage(), 'a.png', 'image/png')], 'image_unsupported'],
  ['HTML を PNG の名前と種類で', () => [image(ascii('<!doctype html><script>1</script>'))], 'image_unsupported'],
  ['動く PNG', () => [image(apngImage(8, 8))], 'image_unsupported'],
  ['動く WebP', () => [image(webpAnimated(8, 8), 'a.webp', 'image/webp')], 'image_unsupported'],
  ['空のファイル', () => [image(new Uint8Array(0))], 'image_unsupported'],
  ['署名だけで続きの無い PNG', () => [image(concatBytes(pngImage(8, 8).subarray(0, 12)))], 'image_unsupported'],
  ['正しい画像の後ろに不正な画像', () => [image(pngImage(8, 8)), image(filler(100))], 'image_unsupported'],
];

test.each(rejected)('%s は決まった形のエラーにし、R2 にも GitHub にも何も送らない', async (_label, files, message) => {
  const person = await createPerson();
  const { app, requests } = fakeGithub();

  await expectImageError(await submit(app, person, files()), message);

  expect(await objectKeys()).toEqual([]);
  expect(requests).toHaveLength(0);
  const db = commonDb(testEnv);
  expect(
    await db.first(
      db.statement((q) => q.selectFrom('rate_limits').select('count').where('key', '=', 'feedback:global')),
    ),
  ).toBeUndefined();
});

test('ちょうど 4MiB の画像と、一辺が 8,192px の画像は通る', async () => {
  const person = await createPerson();
  const { app } = fakeGithub();

  const res = await submit(app, person, [image(pngImage(8, 8, { totalBytes: 4 * MIB })), image(pngImage(8192, 8192))]);

  expect(res.status).toBe(200);
  expect(await objectKeys()).toHaveLength(3);
});

test('文が不正なら、画像が正しくても R2 に置かない', async () => {
  const person = await createPerson();
  const { app } = fakeGithub();

  const res = await submit(app, person, [image(pngImage(8, 8))], { ...input, text: '' });

  expect(res.status).toBe(400);
  expect(await objectKeys()).toEqual([]);
});

test('GitHub App の設定が無ければ 503 で、R2 に何も置かない', async () => {
  const person = await createPerson();
  const { app, requests } = fakeGithub();
  const env = {
    ...testEnv,
    FEEDBACK_GITHUB_APP_ID: undefined,
    FEEDBACK_GITHUB_INSTALLATION_ID: undefined,
    FEEDBACK_GITHUB_PRIVATE_KEY: undefined,
  } as unknown as Env;

  const res = await submit(app, person, [image(pngImage(8, 8))], input, env);

  expect(res.status).toBe(503);
  expect(await objectKeys()).toEqual([]);
  expect(requests).toHaveLength(0);
});

test('全体の枠が上限なら 429 で、R2 に何も置かない', async () => {
  const person = await createPerson();
  const { app } = fakeGithub();
  const db = commonDb(testEnv);
  await db.run(
    db.statement((q) =>
      q
        .insertInto('rate_limits')
        .values({ key: 'feedback:global', count: 60, window_start_at: new Date().toISOString() }),
    ),
  );

  const res = await submit(app, person, [image(pngImage(8, 8))]);

  expect(res.status).toBe(429);
  expect(await objectKeys()).toEqual([]);
});

// 起票されていないと分かる失敗: トークンを取れない、届かない、GitHub が受け付けない（3xx、4xx）
const notCreated: [string, () => ReturnType<typeof fakeGithub>][] = [
  ['起票の応答が 422', () => fakeGithub(() => Response.json({ message: 'Validation Failed' }, { status: 422 }))],
  ['起票の応答が 403', () => fakeGithub(() => new Response('', { status: 403 }))],
  ['起票の応答が 302', () => fakeGithub(() => new Response('', { status: 302, headers: { Location: '/x' } }))],
];

test.each(notCreated)('%s なら 503 で、置いた R2 を消す', async (_label, create) => {
  const person = await createPerson();
  const { app, issues } = create();

  const res = await submit(app, person, [image(pngImage(8, 8))]);

  expect(res.status).toBe(503);
  expect(issues).toHaveLength(1);
  expect(await objectKeys()).toEqual([]);
});

test('GitHub のトークンを取れなければ 503 で、置いた R2 を消す', async () => {
  const person = await createPerson();
  const app = createApp(undefined, { fetcher: async () => new Response('', { status: 500 }) });

  const res = await submit(app, person, [image(pngImage(8, 8))]);

  expect(res.status).toBe(503);
  expect(await objectKeys()).toEqual([]);
});

test('GitHub に届かなければ（接続の失敗）503 で、置いた R2 を消す', async () => {
  const person = await createPerson();
  const app = createApp(undefined, {
    fetcher: async () => {
      throw new TypeError('network');
    },
  });

  const res = await submit(app, person, [image(pngImage(8, 8))]);

  expect(res.status).toBe(503);
  expect(await objectKeys()).toEqual([]);
});

// 起票されたかもしれない失敗: 起票の要求のタイムアウト、5xx、2xx だが応答が読めない
const maybeCreated: [string, () => ReturnType<typeof fakeGithub>][] = [
  ['起票の応答が 502', () => fakeGithub(() => new Response('', { status: 502 }))],
  ['起票の応答が 500', () => fakeGithub(() => new Response('', { status: 500 }))],
  ['起票の応答が 201 で本文が読めない', () => fakeGithub(() => new Response('not json', { status: 201 }))],
  [
    '起票の応答を待ってタイムアウト',
    () =>
      fakeGithub(() => {
        throw new DOMException('timeout', 'TimeoutError');
      }),
  ],
];

test.each(maybeCreated)('%s なら 503 を返し、置いた R2 は残す', async (_label, create) => {
  const person = await createPerson();
  const { app, issues } = create();

  const res = await submit(app, person, [image(pngImage(8, 8))]);

  expect(res.status).toBe(503);
  expect(issues).toHaveLength(1);
  const keys = await objectKeys();
  expect(keys).toHaveLength(2);
  expect(keys.some((key) => key.endsWith('/meta.json'))).toBe(true);
});

test('R2 への書き込みに失敗したら、置けた分を消して 503 を返し、Issue は立てない', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();
  const real = githubEnv.ATTACHMENTS;
  const env = {
    ...githubEnv,
    ATTACHMENTS: {
      put: (key: string, value: never, options: never) =>
        key.endsWith('/meta.json') ? Promise.reject(new Error('r2 down')) : real.put(key, value, options),
      delete: (keys: string | string[]) => real.delete(keys),
    },
  } as unknown as Env;

  const res = await submit(app, person, [image(pngImage(8, 8))], input, env);

  expect(res.status).toBe(503);
  expect(issues).toHaveLength(0);
  expect(await objectKeys()).toEqual([]);
});

test('画像の1つの書き込みが失敗しても、遅れて終わる書き込みを待ってから消し、何も残さない', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();
  const real = githubEnv.ATTACHMENTS;
  let puts = 0;
  const env = {
    ...githubEnv,
    ATTACHMENTS: {
      put: async (key: string, value: never, options: never) => {
        if (key.endsWith('/meta.json')) return real.put(key, value, options);
        puts += 1;
        if (puts === 1) throw new Error('feedback/secret-key r2 down');
        await new Promise((resolve) => setTimeout(resolve, 100));
        return real.put(key, value, options);
      },
      delete: (keys: string | string[]) => real.delete(keys),
    },
  } as unknown as Env;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const res = await submit(app, person, [image(pngImage(8, 8)), image(jpegImage(8, 8))], input, env);

  expect(res.status).toBe(503);
  expect(issues).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await objectKeys()).toEqual([]);
  const logs = error.mock.calls.map((call) => String(call[0]));
  expect(logs.filter((line) => line.includes('フィードバックの R2 に置けなかった'))).toHaveLength(1);
  for (const line of logs) expect(line).not.toContain('secret-key');
});

test('起票の要求だけが送った後に接続断で落ちるときは、今の分類（not_created）のまま R2 を消す', async () => {
  const person = await createPerson();
  const app = createApp(undefined, {
    fetcher: async (requestInput, init) => {
      const request = new Request(requestInput, init);
      if (request.url === FEEDBACK_ISSUES_URL) throw new TypeError('Network connection lost.');
      return fakeFeedbackGithubResponse(request)!;
    },
  });

  const res = await submit(app, person, [image(pngImage(8, 8))]);

  // GitHub の起票の応答を受けられない TypeError は、届かなかった失敗と区別できず、#1552 の分類は not_created
  expect(res.status).toBe(503);
  expect(await objectKeys()).toEqual([]);
});

test('R2 を消せなくても結果は変えず、ログには件数だけを出す', async () => {
  const person = await createPerson();
  const { app } = fakeGithub(() => new Response('', { status: 422 }));
  const real = githubEnv.ATTACHMENTS;
  const env = {
    ...githubEnv,
    ATTACHMENTS: {
      put: (key: string, value: never, options: never) => real.put(key, value, options),
      delete: () => Promise.reject(new Error('feedback/secret-key r2 down')),
    },
  } as unknown as Env;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const res = await submit(app, person, [image(pngImage(8, 8))], input, env);

  expect(res.status).toBe(503);
  const logs = error.mock.calls.map((call) => String(call[0]));
  const removal = logs.filter((line) => line.includes('フィードバックの R2 のファイルを消せなかった'));
  expect(removal).toHaveLength(1);
  expect(JSON.parse(removal[0]!)).toMatchObject({ level: 'error', operation: 'feedback-submit', count: 2 });
  for (const line of logs) {
    expect(line).not.toContain('feedback/');
    expect(line).not.toContain('secret-key');
  }
});
