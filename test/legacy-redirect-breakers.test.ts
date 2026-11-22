// 旧 URL の転送用の Worker（src/legacy-redirect/worker.ts）を崩す手口。test/legacy-redirect.test.ts と重ならないものだけを置く。
// wrangler.legacy-redirect.jsonc の Workers の実行環境で動かす（vitest の project legacy-redirect と同じ設定）
import { exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { isErrorBody } from '../src/shared/errors.ts';

const LEGACY = 'https://scrum-guild.ucan-lab.workers.dev';
const TARGET = 'https://banmen.ucan-lab.workers.dev';

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${LEGACY}${path}`, { redirect: 'manual', ...init });
}

async function expectMoved(res: Response) {
  expect(res.status).toBe(410);
  expect(res.headers.get('location')).toBeNull();
  const body: unknown = await res.json();
  expect(isErrorBody(body)).toBe(true);
  if (!isErrorBody(body)) return;
  expect(body.error.code).toBe('moved');
  expect(body.error.details).toEqual(expect.objectContaining({ location: TARGET }));
}

describe('崩し: URL の解析で /api に化けるパスも 410', () => {
  // WHATWG URL の解析で、%2e%2e は .. として畳まれ、特別なスキームの \ は / になる。解析の後のパスは /api の下
  test.each([
    '/aoba/../api/health',
    '/aoba/%2e%2e/api/health',
    '/aoba/%2E%2e/api/health',
    '/api\\health',
    '/x/..\\api',
  ])('GET %s は 410 の moved', async (path) => {
    await expectMoved(await get(path));
  });

  // RFC 3986 の 6.2.2.2: 予約されていない文字（a、i、p）の百分率符号は、元の文字と同じ URI を指す。
  // 新しい URL の Worker（Hono の basePath('/api')）は、パスを decodeURI してから振り分けるので、/%61pi/health を /api/health として答える。
  // 旧 URL で 302 にすると、/api/* を 410 にする完了条件（Issue #1421）をすり抜けて、API の要求が別のオリジンへ送られる
  test.each(['/%61pi/health', '/ap%69/health', '/%61%70%69/health', '/%61pi'])(
    'GET %s は 410 の moved',
    async (path) => {
      await expectMoved(await get(path));
    },
  );
});

describe('崩し: メソッドの大小', () => {
  // fetch の仕様はメソッドを大文字に揃える（DELETE、GET、HEAD、OPTIONS、POST、PUT だけ）。揃えた後で判定する
  test.each(['get', 'Get'])('%s / は GET と同じ 302', async (method) => {
    const res = await get('/aoba?x=1', { method });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TARGET}/aoba?x=1`);
  });

  test('head / は HEAD と同じ 302 で、本文は空', async () => {
    const res = await get('/aoba', { method: 'head' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TARGET}/aoba`);
    expect(await res.text()).toBe('');
  });

  // patch は揃えられず小文字のまま届く。GET と HEAD のどちらでもないので 410
  test.each(['patch', 'post', 'PROPFIND'])('%s /aoba は 410 の moved', async (method) => {
    await expectMoved(await get('/aoba', { method }));
  });
});

describe('崩し: Location への注入と断片', () => {
  test.each(['/aoba%0D%0ASet-Cookie:%20x=1', '/ao\r\nba?x=1%0d%0aSet-Cookie:%20y=2', '/aoba?q=%0A%0D'])(
    'パス %j でも Location に改行が無く、ほかのヘッダーが増えない',
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(302);
      const location = res.headers.get('location')!;
      expect(location.startsWith(`${TARGET}/`)).toBe(true);
      expect(location).not.toMatch(/[\r\n]/);
      expect(res.headers.get('set-cookie')).toBeNull();
    },
  );

  test('断片の中の ? はクエリにならず、Location に断片の中身が漏れない', async () => {
    const res = await get('/invite#not-a-real-secret?a=1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TARGET}/invite`);
  });

  test('パスとクエリの %23 は符号のまま送り、# にしない', async () => {
    const res = await get('/aoba/wiki/%23x?q=%23y');
    expect(res.headers.get('location')).toBe(`${TARGET}/aoba/wiki/%23x?q=%23y`);
  });
});

describe('崩し: 非 ASCII と長いパス', () => {
  test('符号にしていない非 ASCII のパスとクエリも、百分率符号にして同じ場所へ送る', async () => {
    const res = await get('/aoba/wiki/ページ?q=あ b');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TARGET}/aoba/wiki/%E3%83%9A%E3%83%BC%E3%82%B8?q=%E3%81%82%20b`);
  });

  test('とても長いパスでも、切らずに同じパスへ送る', async () => {
    const path = `/aoba/${'a'.repeat(8000)}`;
    const res = await get(`${path}?x=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TARGET}${path}?x=1`);
  });

  test('とても長い /api の下も 410', async () => {
    await expectMoved(await get(`/api/${'a'.repeat(8000)}`));
  });
});
