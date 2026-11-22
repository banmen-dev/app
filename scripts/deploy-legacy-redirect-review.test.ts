// done-check のレビュー（falsification-qa）で見つかった筋を止めるテスト（#1421）。
// 引数の固定、API の形の 404、本物の問い合わせ（fetchReply）を手元の HTTP サーバーで確かめる
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { LEGACY_REDIRECT_TARGET } from '../src/legacy-redirect/worker.ts';
import { deployLegacyRedirect, fetchReply, LEGACY_ORIGIN, type LegacyRedirectDeps } from './deploy-legacy-redirect.ts';

type Reply = { status: number; location: string | null; body: unknown };

const health: Reply = {
  status: 200,
  location: null,
  body: { status: 'ok', database: 'ok', credentialKeys: 'ok', version: 'v0.1.0' },
};
const moved: Reply = {
  status: 410,
  location: null,
  body: { error: { code: 'moved', message: 'moved', details: { location: LEGACY_REDIRECT_TARGET } } },
};

// 置く前の旧 URL の /api/health の答えを受け、置いた後は転送が効いた答えを返す
function fake(oldHealthBefore: Reply) {
  const wranglerCalls: string[][] = [];
  const errors: string[] = [];
  let deployed = false;
  let clock = 0;
  const deps: LegacyRedirectDeps = {
    request: async (url) => {
      clock += 100;
      if (url === `${LEGACY_REDIRECT_TARGET}/api/health`) return health;
      if (url === `${LEGACY_ORIGIN}/api/health`) return deployed ? moved : oldHealthBefore;
      if (url === `${LEGACY_ORIGIN}/` || url === LEGACY_ORIGIN) {
        return deployed
          ? { status: 302, location: `${LEGACY_REDIRECT_TARGET}/`, body: null }
          : { status: 404, location: null, body: null };
      }
      throw new Error(`想定外の問い合わせ: ${url}`);
    },
    wrangler: (args) => {
      wranglerCalls.push(args);
      deployed = true;
      return { status: 0 };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
    error: (message) => {
      errors.push(message);
    },
  };
  return { deps, wranglerCalls, errors };
}

describe('wrangler に渡す引数', () => {
  test('ちょうど deploy -c wrangler.legacy-redirect.jsonc で、--name や --env や -c の重ねを足さない', async () => {
    const f = fake({ status: 404, location: null, body: null });
    assert.equal(await deployLegacyRedirect(f.deps), 0);
    assert.deepEqual(f.wranglerCalls, [['deploy', '-c', 'wrangler.legacy-redirect.jsonc']]);
  });
});

describe('旧 URL の 404 の見分け', () => {
  test('404 でも本文が API のエラーの形なら、本番の Worker が答えているとみなして置かない', async () => {
    const f = fake({ status: 404, location: null, body: { error: { code: 'not_found', message: 'not found' } } });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.deepEqual(f.wranglerCalls, []);
    assert.ok(f.errors.length > 0);
  });

  test('Worker の無い名前の 404（本文が JSON でない）なら置く', async () => {
    const f = fake({ status: 404, location: null, body: null });
    assert.equal(await deployLegacyRedirect(f.deps), 0);
    assert.equal(f.wranglerCalls.length, 1);
  });
});

describe('本物の問い合わせ（fetchReply）', () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'https://example.invalid/next' });
        res.end();
      } else if (req.url === '/html') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>not found</html>');
      } else if (req.url === '/json') {
        res.writeHead(410, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'moved', message: 'moved' } }));
      } else if (req.url === '/truncated') {
        // 長さを宣言して、本文の途中で切る（読み取りが途中で打ち切られた応答）
        res.writeHead(404, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"error":{"code":"not_fou');
        setTimeout(() => res.socket?.destroy(), 20);
      } else if (req.url === '/hang') {
        // 答えない
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('302 を辿らず、状態と Location を返す', async () => {
    const reply = await fetchReply(`${origin}/redirect`, 2_000);
    assert.equal(reply.status, 302);
    assert.equal(reply.location, 'https://example.invalid/next');
    assert.equal(reply.body, null);
  });

  test('JSON でない本文は null にする', async () => {
    const reply = await fetchReply(`${origin}/html`, 2_000);
    assert.equal(reply.status, 404);
    assert.equal(reply.body, null);
  });

  test('JSON の本文は読む', async () => {
    const reply = await fetchReply(`${origin}/json`, 2_000);
    assert.equal(reply.status, 410);
    assert.deepEqual(reply.body, { error: { code: 'moved', message: 'moved' } });
  });

  test('本文を読み切れなければ、JSON でないとみなさず投げる（Worker の無い 404 と取り違えない）', async () => {
    await assert.rejects(fetchReply(`${origin}/truncated`, 2_000));
  });

  test('答えなければ打ち切りの時間で投げる', async () => {
    await assert.rejects(fetchReply(`${origin}/hang`, 100));
  });
});
