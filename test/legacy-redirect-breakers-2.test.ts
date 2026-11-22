// 旧 URL の転送用の Worker（src/legacy-redirect/worker.ts）を崩す手口の2周目。
// test/legacy-redirect.test.ts と test/legacy-redirect-breakers.test.ts と重ならないものだけを置く。
// wrangler.legacy-redirect.jsonc の Workers の実行環境で動かす（vitest の project legacy-redirect と同じ設定）
import { exports } from 'cloudflare:workers';
import { Hono } from 'hono';
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

// 新しい URL の Worker と同じ形の Hono（src/server/app.ts の new Hono().basePath('/api')）。
// 既定の getPath（百分率符号の解き方）と router を使い、/api の下に当たったかだけを返す
const newApp = new Hono().basePath('/api');
newApp.all('/*', (c) => c.text('api'));

async function honoRoutesToApi(path: string): Promise<boolean> {
  const res = await newApp.request(`${TARGET}${path}`);
  return res.status === 200 && (await res.text()) === 'api';
}

describe('崩し: 百分率符号の境目で、新しい URL の Hono の振り分けと食い違わない', () => {
  // 比べる相手の Hono が、/api の下とそれ以外を見分けていること
  test('比べる Hono は /api と /%61pi を API に、/apiary と /aoba を API の外にする', async () => {
    expect(await honoRoutesToApi('/api')).toBe(true);
    expect(await honoRoutesToApi('/api/health')).toBe(true);
    expect(await honoRoutesToApi('/%61pi/health')).toBe(true);
    expect(await honoRoutesToApi('/apiary')).toBe(false);
    expect(await honoRoutesToApi('/aoba')).toBe(false);
  });

  // 新しい URL の Hono が /api の下として答えるパスは、旧 URL で 302 にすると API の要求が別のオリジンへ送られる（Issue #1421）。
  // 逆に、Hono が /api の下と見ないパスは画面のパスなので、GET は 302 で送る（docs/operations.md の「旧 URL の転送」）
  test.each([
    // 解けない並び（途中で切れた UTF-8）が、別の区切りの %61 を解くのを妨げない
    '/%61pi/%E3%81/health',
    '/%61%70%69/%FF',
    // 解けない並びと続いた %61 は Hono も解かない
    '/%61%70%69%FF/health',
    // %25 があっても、ほかの百分率符号は解く
    '/%61pi/%25',
    '/%61pi/health?x=%25',
    // 二重符号は Hono が1段しか解かないので /api にならない
    '/%2561pi/health',
    '/%25%36%31pi/health',
    // decodeURI は %2F を解かないので、/ にならない
    '/api%2Fhealth',
    '/%61pi%2Fhealth',
    '/%2Fapi/health',
    // 解いた結果が /api ちょうどでも /api/ の下でもない
    '/api%00',
    '/%61pi%',
    '/%61pi%2',
    '/api%20',
    '/api;x',
    // 大小は区別する
    '/ap%49/health',
    '/API/health',
    // %252e%252e は .. にならない
    '/aoba/%252e%252e/api/health',
  ])('GET %s', async (path) => {
    const api = await honoRoutesToApi(path);
    const res = await get(path);
    if (api) {
      await expectMoved(res);
    } else {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${TARGET}${new URL(`${LEGACY}${path}`).pathname}${new URL(`${LEGACY}${path}`).search}`,
      );
    }
  });

  test('解けない並びの後ろの %61pi も、Hono と同じく API として 410', async () => {
    expect(await honoRoutesToApi('/%61pi/%E3%81/health')).toBe(true);
    await expectMoved(await get('/%61pi/%E3%81/health'));
  });

  test('二重符号の /%2561pi は Hono が API にしないので、符号のまま画面として送る', async () => {
    expect(await honoRoutesToApi('/%2561pi/health')).toBe(false);
    const res = await get('/%2561pi/health?x=1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TARGET}/%2561pi/health?x=1`);
  });
});

describe('崩し: Location は受けたパスとクエリを解かずに送る', () => {
  // 「同じパスとクエリ」（Issue #1421）。%25 を解くと別のパス（/100%）になる
  test('%25 と %2F は解かず、二重にも符号にしない', async () => {
    const res = await get('/aoba/wiki/100%25/a%2Fb?q=%25&r=%2F');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${TARGET}/aoba/wiki/100%25/a%2Fb?q=%25&r=%2F`);
  });

  test('ヘッダーに置けない記号は Location に生で現れない', async () => {
    const res = await get('/aoba/"<x>`{y}?q="<z>\' ');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith(`${TARGET}/aoba/`)).toBe(true);
    expect(location).not.toMatch(/["<>`{} ]/);
  });
});

describe('崩し: HEAD と プリフライト', () => {
  // RFC 9110 の 9.3.2: HEAD の応答に本文を付けない
  test('HEAD /api/health の 410 は本文が空', async () => {
    const res = await get('/api/health', { method: 'HEAD' });
    expect(res.status).toBe(410);
    expect(await res.text()).toBe('');
  });

  // ブラウザのプリフライトにも、転送先へ送らせる 3xx を返さない
  test('OPTIONS /api/ops/story-create のプリフライトも 410 の moved', async () => {
    const res = await get('/api/ops/story-create', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    await expectMoved(res);
  });
});
