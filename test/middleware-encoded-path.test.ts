// 全リクエストに掛けるミドルウェア（src/server/app.ts のパスを付けない app.use）が、符号化した行の終わりの文字を含む
// パスでも飛ばされないこと。hono 4.13.15 以前の RegExpRouter は、ワイルドカードを `.*` の正規表現にしていて、
// 改行などに当たらず、`%0A` や `%E2%80%A8` を含むパスでワイルドカードのミドルウェアを飛ばした（GHSA-h7mg-cq63-vhpq。#1353）。
// 飛ばされると、応答に Content-Security-Policy などのヘッダーが付かない
import { env, exports } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import type { AppEnv } from '../src/server/app-env.ts';
import { apiCacheControl, apiCsp, attachmentCsp, fixedHeaders } from '../src/shared/security-headers.ts';

// 行の終わりとして扱われうる文字（LF、CR、NEL、LS、PS）を、パーセントで符号化したもの
const lineTerminators = ['%0A', '%0D', '%0D%0A', '%C2%85', '%E2%80%A8', '%E2%80%A9'] as const;

type Case = { path: string; method: 'GET' | 'POST'; binary: boolean };

// 引数（:slug、:provider、:id）の位置と、ルートの無い位置に行の終わりを入れたパス。
// 引数のあるルートに当たるもの（ハンドラーまで届く）と、当たらず 404 になるものの両方を並べる
function paths(t: string): Case[] {
  return [
    { path: `/api/health${t}`, method: 'GET', binary: false },
    { path: `/api/${t}health`, method: 'GET', binary: false },
    { path: `/api/auth/github${t}/start`, method: 'GET', binary: false },
    { path: `/api/auth/${t}/callback`, method: 'GET', binary: false },
    { path: `/api/auth/a${t}b/start`, method: 'POST', binary: false },
    { path: `/api/aoba${t}/favorite-list`, method: 'POST', binary: false },
    { path: `/api/${t}/favorite-list`, method: 'POST', binary: false },
    { path: `/api/aoba/favorite-list${t}`, method: 'POST', binary: false },
    { path: `/api/client-errors${t}`, method: 'POST', binary: false },
    { path: `/api/aoba/attachments/${t}`, method: 'GET', binary: true },
    { path: `/api/aoba${t}/user-avatar/x${t}y`, method: 'GET', binary: true },
    { path: `/api/${t}`, method: 'GET', binary: false },
  ];
}

const cases = lineTerminators.flatMap((t) => paths(t));

function init(method: Case['method']): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  };
}

async function expectSecurityHeaders(res: Response, binary: boolean) {
  // 応答の中身はルートごとに違う（404、401、400 など）。ここではミドルウェアが掛かったことだけを見る
  const csp = res.headers.get('content-security-policy');
  expect(csp, 'content-security-policy').not.toBeNull();
  // 引数のあるバイナリの操作に当たったときだけ添付の CSP になりうる。どちらでもない値は飛ばされたとみなす
  expect(binary ? [apiCsp, attachmentCsp] : [apiCsp]).toContain(csp);
  for (const [name, value] of Object.entries(fixedHeaders)) {
    expect(res.headers.get(name), name).toBe(value);
  }
  expect(res.headers.get('cache-control'), 'cache-control').not.toBeNull();
  if (!binary) expect(res.headers.get('cache-control')).toBe(apiCacheControl);
  await res.body?.cancel();
}

describe('符号化した行の終わりを含むパス', () => {
  // 本番と同じ入口（Worker の fetch）。今の操作の数とルートの形では、hono の SmartRouter は TrieRouter を選ぶ
  test.each(cases)('Worker: $method $path にもセキュリティのヘッダーが付く', async ({ path, method, binary }) => {
    const res = await exports.default.fetch(`http://example.com${path}`, init(method));
    await expectSecurityHeaders(res, binary);
  });

  // ルートの形が変わり、SmartRouter が RegExpRouter を選んだときにも効くこと。操作を持たないアプリは RegExpRouter を選ぶ
  // （hono 4.13.13 では、この組で `/api/%0A` などの応答から Content-Security-Policy が抜けた）
  describe('RegExpRouter を選ぶアプリ', () => {
    const app = createApp([]);

    test('SmartRouter が RegExpRouter を選んでいる（選ばなくなったら、この組は確かめる意味を失う）', async () => {
      const res = await app.request('/api/health', {}, env);
      await res.body?.cancel();
      const router = (app as Hono<AppEnv>).router as { activeRouter?: { name: string } };
      expect(router.activeRouter?.name).toBe('RegExpRouter');
    });

    test.each(cases)('$method $path にもセキュリティのヘッダーが付く', async ({ path, method, binary }) => {
      const res = await app.request(path, init(method), env);
      await expectSecurityHeaders(res, binary);
    });
  });
});
