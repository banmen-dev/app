// 旧 URL の転送用の Worker（src/legacy-redirect/worker.ts）。wrangler.legacy-redirect.jsonc の Workers の実行環境で動かす（vitest の project legacy-redirect）
import { exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { isErrorBody } from '../src/shared/errors.ts';
import worker, { LEGACY_REDIRECT_TARGET } from '../src/legacy-redirect/worker.ts';

const LEGACY = 'https://scrum-guild.ucan-lab.workers.dev';
const TARGET = 'https://banmen.ucan-lab.workers.dev';

// 実行環境の入口（wrangler.legacy-redirect.jsonc の main）を通して旧 URL に問い合わせる。リダイレクトは辿らない
function get(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${LEGACY}${path}`, { redirect: 'manual', ...init });
}

// 302 で、Location が転送先のオリジンにあることを確かめて Location を返す
function expectRedirect(res: Response): string {
  expect(res.status).toBe(302);
  const location = res.headers.get('location');
  expect(location).not.toBeNull();
  expect(new URL(location!).origin).toBe(TARGET);
  expect(location!.startsWith(`${TARGET}/`)).toBe(true);
  return location!;
}

// 410 の moved で、本文が API のエラーの形、details.location が新しい URL であることを確かめる
async function expectMoved(res: Response) {
  expect(res.status).toBe(410);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('content-type') ?? '').toMatch(/^application\/json\b/);
  const body: unknown = await res.json();
  expect(isErrorBody(body)).toBe(true);
  if (!isErrorBody(body)) return;
  expect(body.error.code).toBe('moved');
  expect(body.error.details).toEqual(expect.objectContaining({ location: TARGET }));
}

describe('転送先', () => {
  test('LEGACY_REDIRECT_TARGET は新しい URL で、末尾に / を付けない', () => {
    expect(LEGACY_REDIRECT_TARGET).toBe(TARGET);
  });
});

describe('完了条件: 画面のパスとクエリは新しい URL の同じパスとクエリへ 302 で送る', () => {
  test.each([
    ['/', `${TARGET}/`],
    ['/aoba', `${TARGET}/aoba`],
    ['/aoba/backlog/stories/12', `${TARGET}/aoba/backlog/stories/12`],
    ['/aoba/board?sprint=3', `${TARGET}/aoba/board?sprint=3`],
    ['/aoba/wiki?q=%E3%81%82%20b&page=2&sort=updated', `${TARGET}/aoba/wiki?q=%E3%81%82%20b&page=2&sort=updated`],
    ['/aoba/wiki/%E3%83%9A%E3%83%BC%E3%82%B8', `${TARGET}/aoba/wiki/%E3%83%9A%E3%83%BC%E3%82%B8`],
    ['/login?next=%2Faoba%3Fx%3D1', `${TARGET}/login?next=%2Faoba%3Fx%3D1`],
    ['/invite', `${TARGET}/invite`],
  ])('GET %s は %s へ', async (path, location) => {
    const res = await get(path);
    expect(expectRedirect(res)).toBe(location);
  });

  test('空のクエリ（?）は、? を付けるか付けないかのどちらかで同じパスへ送る', async () => {
    const res = await get('/today?');
    expect([`${TARGET}/today`, `${TARGET}/today?`]).toContain(expectRedirect(res));
  });

  test('同じキーが並ぶクエリも順に保つ', async () => {
    const res = await get('/aoba/backlog?label=a&label=b&label=a');
    expect(expectRedirect(res)).toBe(`${TARGET}/aoba/backlog?label=a&label=b&label=a`);
  });

  test('HEAD も 302 で同じ Location を返し、本文は空', async () => {
    const res = await get('/aoba/board?sprint=3', { method: 'HEAD' });
    expect(expectRedirect(res)).toBe(`${TARGET}/aoba/board?sprint=3`);
    expect(await res.text()).toBe('');
  });

  test.each(['/apiary', '/api-docs', '/apis/x', '/aoba/api/health'])(
    '%s は /api で始まっても API ではないので画面として 302',
    async (path) => {
      const res = await get(path);
      expect(expectRedirect(res)).toBe(`${TARGET}${path}`);
    },
  );
});

describe('前提: 301 にしない', () => {
  test.each(['/', '/aoba?x=1'])('GET %s は 301 でも 307、308 でもなく 302', async (path) => {
    const res = await get(path);
    expect(res.status).not.toBe(301);
    expect(res.status).not.toBe(308);
    expect(res.status).toBe(302);
  });
});

describe('前提: Location に断片を付けない（招待の秘密はブラウザが引き継ぎ、サーバーに届かない）', () => {
  test('断片の付いた URL を受けても Location に # が無い', async () => {
    const res = await get('/invite#not-a-real-secret');
    const location = expectRedirect(res);
    expect(location).not.toContain('#');
    expect(location).not.toContain('not-a-real-secret');
    expect(location).toBe(`${TARGET}/invite`);
  });

  test('クエリの後ろの断片も付けない', async () => {
    const res = await get('/aoba/wiki?q=a#section');
    const location = expectRedirect(res);
    expect(location).not.toContain('#');
    expect(location).toBe(`${TARGET}/aoba/wiki?q=a`);
  });
});

describe('完了条件: /api/* は新しい URL を書いた 410 にする', () => {
  test.each([
    '/api',
    '/api/',
    '/api/health',
    '/api/x?y',
    '/api/ops/story-list?org=aoba',
    '/api/auth/google/callback?code=c',
  ])('GET %s は 410 の moved で、Location を付けない', async (path) => {
    await expectMoved(await get(path));
  });

  test('HEAD /api/health も 302 にせず 410', async () => {
    const res = await get('/api/health', { method: 'HEAD' });
    expect(res.status).toBe(410);
    expect(res.headers.get('location')).toBeNull();
  });

  test('API に Authorization を付けても 410 で、転送先へ送らせない', async () => {
    const res = await get('/api/health', { headers: { authorization: 'Bearer not-a-real-token' } });
    await expectMoved(res);
  });
});

describe('完了条件: GET と HEAD 以外は画面のパスでも 410 にする', () => {
  test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('%s / は 410 の moved', async (method) => {
    await expectMoved(await get('/', { method }));
  });

  test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('%s /aoba/board?x=1 は 410 の moved', async (method) => {
    await expectMoved(await get('/aoba/board?x=1', { method }));
  });

  test.each(['POST', 'PUT', 'DELETE', 'PATCH'])(
    '%s /api/ops/story-create は本文があっても 410 の moved',
    async (method) => {
      const res = await get('/api/ops/story-create', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '架空の作業' }),
      });
      await expectMoved(res);
    },
  );
});

describe('すり抜け: 転送先は固定で、別のオリジンへ送らない', () => {
  test.each([
    { host: 'evil.example' },
    { 'x-forwarded-host': 'evil.example' },
    { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' },
    { forwarded: 'host=evil.example;proto=http' },
  ] as Record<string, string>[])('ヘッダー %o を変えても Location は新しい URL で始まる', async (headers) => {
    const res = await get('/aoba?x=1', { headers });
    expect(expectRedirect(res)).toBe(`${TARGET}/aoba?x=1`);
  });

  test.each(['//evil.example', '//evil.example/aoba?x=1', '//evil.example/%2F..', '/%2F%2Fevil.example'])(
    'パス %s でも Location のオリジンは新しい URL',
    async (path) => {
      const res = await get(path);
      const location = expectRedirect(res);
      expect(location).not.toMatch(/^\/\//);
      expect(new URL(location).host).toBe('banmen.ucan-lab.workers.dev');
    },
  );

  test('// で始まるパスは、そのパスのまま新しい URL へ送る', async () => {
    const res = await get('//evil.example/aoba');
    expect(expectRedirect(res)).toBe(`${TARGET}//evil.example/aoba`);
  });

  test('ほかのホスト名で届いた要求も新しい URL へ送る', async () => {
    const res = await exports.default.fetch('http://example.com/aoba?x=1', { redirect: 'manual' });
    expect(expectRedirect(res)).toBe(`${TARGET}/aoba?x=1`);
  });

  test('410 の details.location もヘッダーで変わらない', async () => {
    const res = await get('/api/health', { headers: { 'x-forwarded-host': 'evil.example' } });
    await expectMoved(res);
  });
});

describe('ランタイム', () => {
  test('入口は src/legacy-redirect/worker.ts で、直に呼んでも同じ応答', async () => {
    const direct = await worker.fetch(new Request(`${LEGACY}/aoba?x=1`));
    const viaRuntime = await get('/aoba?x=1');
    expect(direct.status).toBe(302);
    expect(direct.headers.get('location')).toBe(`${TARGET}/aoba?x=1`);
    expect(viaRuntime.status).toBe(direct.status);
    expect(viaRuntime.headers.get('location')).toBe(direct.headers.get('location'));
  });

  test('直に呼んでも API は 410 の moved', async () => {
    await expectMoved(await worker.fetch(new Request(`${LEGACY}/api/health`)));
  });
});
