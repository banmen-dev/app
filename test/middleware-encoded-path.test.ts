// 全リクエストに掛けるミドルウェア（src/server/app.ts のパスを付けない app.use）が、符号化した行の終わりの文字を含む
// パスでも飛ばされないこと。hono の RegExpRouter は、4.13.15 以前ではワイルドカードを `.*` の正規表現にしていて、
// 改行などに当たらず、`%0A` や `%E2%80%A8` を含むパスでワイルドカードのミドルウェアを飛ばした（GHSA-h7mg-cq63-vhpq。#1353）。
// 飛ばされると、応答に Content-Security-Policy などのヘッダーが付かない。下の「4.13.13」は、当たる版のうち、このリポジトリが
// 上げる前に使っていて、このテストが落ちることを確かめた版
import { env, exports } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { apiCacheControl, apiCsp, attachmentCsp, fixedHeaders } from '../src/shared/security-headers.ts';

// 行の終わりとして扱われうる文字（LF、CR、NEL、LS、PS）を、パーセントで符号化したもの。NEL（U+0085）は正規表現の `.` に
// 当たるので 4.13.13 でも飛ばされず、回帰の確かめだけになる（advisory の直しを確かめるのは LF、CR、LS、PS）
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
  // 本番と同じ入口（Worker の fetch）。今の操作の数とルートの形では、hono の SmartRouter は TrieRouter を選び、
  // TrieRouter は 4.13.13 でもこの不具合に当たらない。この組は、本番がどちらのルーターを選んでも効くことを確かめる
  // （advisory の直しそのものは、下の RegExpRouter の組が確かめる）
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
      // SmartRouter の activeRouter は hono の型に出ていない項目。hono の更新で名前が変わったら、ここが落ちる
      const router = app.router as { activeRouter?: { name: string } };
      expect(router.activeRouter?.name).toBe('RegExpRouter');
    });

    // 操作を持たないので、バイナリの操作のパスも 404 になり、添付の CSP にはならない。API の値だけを許す
    test.each(cases)('$method $path にもセキュリティのヘッダーが付く', async ({ path, method }) => {
      const res = await app.request(path, init(method), env);
      await expectSecurityHeaders(res, false);
    });
  });

  // セキュリティのヘッダーの後に掛ける設定の検査（運用者の一覧、PUBLIC_ORIGIN、DEV_NOW）も飛ばされないこと。
  // 設定が壊れていれば、ルートに当たるかに関わらず 500 になる。飛ばされると 404 か、ハンドラーの応答になる
  describe('設定の検査', () => {
    const brokenEnvs = [
      // reason は、src/server/app.ts のその検査がログに出す理由。500 がどの検査から出たかを確かめる
      {
        label: 'OPERATOR_LOGIN_IDS の形が合わない',
        patch: { OPERATOR_LOGIN_IDS: 'github:abc' },
        reason: 'OPERATOR_LOGIN_IDS に形の合わない項目がある',
      },
      {
        label: 'PUBLIC_ORIGIN が手元でない http',
        patch: { PUBLIC_ORIGIN: 'http://example.com' },
        reason: 'PUBLIC_ORIGIN が https でも、手元のホストへの http でもない',
      },
      {
        // テストの環境の PUBLIC_ORIGIN に頼らず、本番の形の https を明示する
        label: 'DEV_NOW が本番の公開 URL で設定されている',
        patch: { PUBLIC_ORIGIN: 'https://banmen.example', DEV_NOW: '2026-10-26T10:00:00+09:00' },
        reason: 'DEV_NOW が、手元のホストへの http でない PUBLIC_ORIGIN で設定されている',
      },
    ];
    const apps = [
      { name: '本番と同じアプリ', app: createApp() },
      { name: 'RegExpRouter を選ぶアプリ', app: createApp([]) },
    ];
    const encodedCases = ['%0A', '%E2%80%A8'].flatMap((t) => [
      { path: `/api/${t}`, method: 'GET' as const },
      { path: `/api/health${t}`, method: 'GET' as const },
      { path: `/api/aoba${t}/favorite-list`, method: 'POST' as const },
      { path: `/api/client-errors${t}`, method: 'POST' as const },
    ]);
    const matrix = apps.flatMap((a) =>
      brokenEnvs.flatMap((b) => encodedCases.map((c) => ({ ...c, appName: a.name, app: a.app, ...b }))),
    );

    test.each(matrix)(
      '$appName: $label なら $method $path も 500 にする',
      async ({ app, patch, reason, path, method }) => {
        const broken = Object.assign({}, env, patch) as unknown as Env;
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const res = await app.request(path, init(method), broken);
          expect(res.status).toBe(500);
          expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
          expect(res.headers.get('content-security-policy')).toBe(apiCsp);
          // ほかの検査や onError ではなく、その検査が1回だけ止めた
          expect(error).toHaveBeenCalledTimes(1);
          expect(JSON.parse(error.mock.calls[0]![0] as string)).toMatchObject({
            level: 'error',
            code: 'internal',
            reason,
          });
        } finally {
          error.mockRestore();
        }
      },
    );
  });
});
