import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEGACY_REDIRECT_TARGET } from '../src/legacy-redirect/worker.ts';
import { deployLegacyRedirect, LEGACY_ORIGIN, type LegacyRedirectDeps } from './deploy-legacy-redirect.ts';

type Reply = { status: number; location: string | null; body: unknown };
// 1回の問い合わせの答え。Error は届かない（request が投げる）
type Answer = Reply | Error;

const NEW_HEALTH = `${LEGACY_REDIRECT_TARGET}/api/health`;
const OLD_HEALTH = `${LEGACY_ORIGIN}/api/health`;

const health = (version = 'abc1234'): Reply => ({
  status: 200,
  location: null,
  body: { status: 'ok', database: 'ok', credentialKeys: 'ok', version },
});
const errorReply = (status: number, code: string): Reply => ({
  status,
  location: null,
  body: { error: { code, message: code } },
});
const moved: Reply = {
  status: 410,
  location: null,
  body: { error: { code: 'moved', message: 'moved', details: { location: LEGACY_REDIRECT_TARGET } } },
};
// Worker の無い workers.dev の名前の答え（本文は JSON でない）
const noWorker: Reply = { status: 404, location: null, body: null };
const redirectTo = (location: string): Reply => ({ status: 302, location, body: null });
const unreachable = () => new Error('fetch failed');

// 1時間。時間の上限の具体値は決め打ちしない。これを超えても終わらなければ、上限を見ていないとみなして投げる
const RUNAWAY_MS = 60 * 60 * 1000;
const RUNAWAY_REQUESTS = 10_000;

type Fake = {
  deps: LegacyRedirectDeps;
  requests: { url: string; timeoutMs: number; afterDeploy: boolean }[];
  wranglerCalls: string[][];
  // wrangler を呼んだ時点の問い合わせの数
  requestsAtWrangler: number[];
  logs: string[];
  errors: string[];
  clock: () => number;
};

// 問い合わせの答えは URL で選ぶ。wrangler を呼ぶ前は before、呼んで成功した後は after を使う。
// 関数は、その URL への（before と after それぞれでの）何回目かを受けて答えを返す。
// 旧 URL の / は `${LEGACY_ORIGIN}` と `${LEGACY_ORIGIN}/` のどちらで問い合わせても同じとみなす
type Responder = Partial<Record<'newHealth' | 'oldHealth' | 'oldRoot', (call: number) => Answer>>;

function fake(options: { before?: Responder; after?: Responder; wranglerStatus?: number; requestMs?: number }): Fake {
  const requests: Fake['requests'] = [];
  const wranglerCalls: string[][] = [];
  const requestsAtWrangler: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  let deployed = false;
  const counts = new Map<string, number>();
  const before: Required<Responder> = {
    newHealth: () => health(),
    oldHealth: () => noWorker,
    oldRoot: () => noWorker,
    ...options.before,
  };
  const after: Required<Responder> = {
    newHealth: () => health(),
    oldHealth: () => moved,
    oldRoot: () => redirectTo(`${LEGACY_REDIRECT_TARGET}/`),
    ...options.after,
  };
  const guard = () => {
    if (clock > RUNAWAY_MS || requests.length > RUNAWAY_REQUESTS) {
      throw new Error('時間の上限を過ぎても終わらない');
    }
  };
  return {
    requests,
    wranglerCalls,
    requestsAtWrangler,
    logs,
    errors,
    clock: () => clock,
    deps: {
      request: async (url, timeoutMs) => {
        requests.push({ url, timeoutMs, afterDeploy: deployed });
        guard();
        clock += options.requestMs ?? 100;
        const key =
          url === NEW_HEALTH
            ? 'newHealth'
            : url === OLD_HEALTH
              ? 'oldHealth'
              : url === LEGACY_ORIGIN || url === `${LEGACY_ORIGIN}/`
                ? 'oldRoot'
                : undefined;
        if (key === undefined) throw new Error(`想定外の問い合わせ: ${url}`);
        const phase = deployed ? after : before;
        const countKey = `${deployed}:${key}`;
        const call = (counts.get(countKey) ?? 0) + 1;
        counts.set(countKey, call);
        const answer = phase[key](call);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      wrangler: (args) => {
        wranglerCalls.push(args);
        requestsAtWrangler.push(requests.length);
        const status = options.wranglerStatus ?? 0;
        if (status === 0) deployed = true;
        return { status };
      },
      sleep: async (ms) => {
        assert.ok(ms >= 0, 'sleep に負の時間');
        clock += ms;
        guard();
      },
      now: () => clock,
      log: (message) => {
        logs.push(message);
      },
      error: (message) => {
        errors.push(message);
      },
    },
  };
}

// wrangler の引数に deploy と -c wrangler.legacy-redirect.jsonc を含む
function assertDeployArgs(args: string[]) {
  assert.ok(args.includes('deploy'), `deploy が無い: ${args.join(' ')}`);
  const c = args.indexOf('-c');
  assert.ok(c >= 0, `-c が無い: ${args.join(' ')}`);
  assert.equal(args[c + 1], 'wrangler.legacy-redirect.jsonc');
}

// 止まった: 0 以外を返し、wrangler を呼ばず、error に理由を出した
async function assertStoppedBeforeDeploy(f: Fake) {
  const code = await deployLegacyRedirect(f.deps);
  assert.notEqual(code, 0);
  assert.deepEqual(f.wranglerCalls, []);
  assert.ok(f.errors.length > 0, 'error に理由が出ていない');
}

describe('完了条件: 名前を変えた後なら置いて確かめる', () => {
  test('新しい URL が 200 の health で旧 URL が 404 なら、wrangler を1回呼び、確かめが効けば 0', async () => {
    const f = fake({});
    assert.equal(await deployLegacyRedirect(f.deps), 0);
    assert.equal(f.wranglerCalls.length, 1);
    assertDeployArgs(f.wranglerCalls[0]!);
    assert.deepEqual(f.errors, []);
  });

  test('置く前に新しい URL と旧 URL の /api/health を問い合わせる', async () => {
    const f = fake({});
    await deployLegacyRedirect(f.deps);
    const beforeDeploy = f.requests.filter((r) => !r.afterDeploy).map((r) => r.url);
    assert.ok(beforeDeploy.includes(NEW_HEALTH), `新しい URL を見ていない: ${beforeDeploy.join(', ')}`);
    assert.ok(beforeDeploy.includes(OLD_HEALTH), `旧 URL を見ていない: ${beforeDeploy.join(', ')}`);
  });

  test('置いた後に、旧 URL の / と /api/health で転送を確かめる', async () => {
    const f = fake({});
    assert.equal(await deployLegacyRedirect(f.deps), 0);
    const afterDeploy = f.requests.filter((r) => r.afterDeploy).map((r) => r.url);
    assert.ok(
      afterDeploy.includes(OLD_HEALTH),
      `置いた後に旧 URL の /api/health を見ていない: ${afterDeploy.join(', ')}`,
    );
    assert.ok(
      afterDeploy.includes(LEGACY_ORIGIN) || afterDeploy.includes(`${LEGACY_ORIGIN}/`),
      `置いた後に旧 URL の / を見ていない: ${afterDeploy.join(', ')}`,
    );
  });

  test('問い合わせの打ち切りの時間は正の値', async () => {
    const f = fake({});
    await deployLegacyRedirect(f.deps);
    assert.ok(f.requests.length > 0);
    for (const r of f.requests) assert.ok(r.timeoutMs > 0, `${r.url} の打ち切りが ${r.timeoutMs}`);
  });
});

describe('完了条件: 名前を変える前（旧 URL が本番の health を返す）には止まる', () => {
  test('旧 URL が 200 の health なら wrangler を呼ばずに 0 以外', async () => {
    await assertStoppedBeforeDeploy(fake({ before: { oldHealth: () => health('old-sha') } }));
  });

  test('旧 URL が新しい URL と同じ版の health でも止まる（同じ Worker が両方の名前で応える）', async () => {
    await assertStoppedBeforeDeploy(fake({ before: { oldHealth: () => health() } }));
  });

  test('旧 URL が何度問い合わせても health なら、時間が経っても wrangler を呼ばない', async () => {
    const f = fake({ before: { oldHealth: () => health('old-sha') } });
    await assertStoppedBeforeDeploy(f);
  });
});

describe('前提: 旧 URL の 404 と 410 の moved のときだけ置く', () => {
  test('旧 URL が 410 の moved（やり直しの実行）なら wrangler を呼ぶ', async () => {
    const f = fake({ before: { oldHealth: () => moved, oldRoot: () => redirectTo(`${LEGACY_REDIRECT_TARGET}/`) } });
    assert.equal(await deployLegacyRedirect(f.deps), 0);
    assert.equal(f.wranglerCalls.length, 1);
    assertDeployArgs(f.wranglerCalls[0]!);
  });

  for (const [name, reply] of [
    ['503 の unavailable', errorReply(503, 'unavailable')],
    ['500 の internal', errorReply(500, 'internal')],
    ['503 で本文が JSON でない', { status: 503, location: null, body: null }],
    ['200 だが health でない本文', { status: 200, location: null, body: { status: 'ok' } }],
    ['200 で本文が JSON でない', { status: 200, location: null, body: null }],
    ['302 で新しい URL へ送る', redirectTo(`${LEGACY_REDIRECT_TARGET}/api/health`)],
    ['301', { status: 301, location: `${LEGACY_REDIRECT_TARGET}/api/health`, body: null }],
    ['410 だが code が moved でない', errorReply(410, 'not_found')],
    ['410 で本文が JSON でない', { status: 410, location: null, body: null }],
    ['410 で本文が API のエラーの形でない', { status: 410, location: null, body: { code: 'moved' } }],
    ['401 の unauthenticated', errorReply(401, 'unauthenticated')],
  ] satisfies [string, Reply][]) {
    test(`旧 URL が ${name} なら wrangler を呼ばない`, async () => {
      await assertStoppedBeforeDeploy(fake({ before: { oldHealth: () => reply } }));
    });
  }

  test('旧 URL に届かない（request が投げる）なら wrangler を呼ばない', async () => {
    await assertStoppedBeforeDeploy(fake({ before: { oldHealth: () => unreachable() } }));
  });
});

describe('前提: 新しい URL の /api/health が ok のときだけ置く', () => {
  for (const [name, answer] of [
    ['health でない本文', { status: 200, location: null, body: { status: 'ok', version: 'abc1234' } }],
    ['200 で本文が JSON でない', { status: 200, location: null, body: null }],
    ['503 の unavailable', errorReply(503, 'unavailable')],
    ['503 で本文が health', { ...health(), status: 503 }],
    ['404（まだ名前を変えていない）', noWorker],
    ['302', redirectTo('https://evil.example/api/health')],
    ['届かない', unreachable],
  ] satisfies [string, Reply | (() => Error)][]) {
    test(`新しい URL が ${name} なら wrangler を呼ばない`, async () => {
      const reply = (): Answer => (typeof answer === 'function' ? answer() : answer);
      await assertStoppedBeforeDeploy(fake({ before: { newHealth: reply } }));
    });
  }
});

describe('断る場合: wrangler が失敗したら確かめに進まない', () => {
  test('wrangler が 0 以外なら 0 以外を返し、置いた後の問い合わせをしない', async () => {
    const f = fake({ wranglerStatus: 1 });
    const code = await deployLegacyRedirect(f.deps);
    assert.notEqual(code, 0);
    assert.equal(f.wranglerCalls.length, 1);
    // 失敗した後は旧 URL の / も /api/health も問い合わせない
    const after = f.requests.slice(f.requestsAtWrangler[0]).map((r) => r.url);
    assert.deepEqual(after, [], `wrangler の失敗の後も問い合わせている: ${after.join(', ')}`);
    assert.ok(f.errors.length > 0, 'error に理由が出ていない');
  });
});

describe('置いた後の確かめ', () => {
  test('最初は前の答え（404）でも、時間内に効けば 0', async () => {
    const f = fake({
      after: {
        oldHealth: (call) => (call === 1 ? noWorker : moved),
        oldRoot: (call) => (call === 1 ? noWorker : redirectTo(`${LEGACY_REDIRECT_TARGET}/`)),
      },
    });
    assert.equal(await deployLegacyRedirect(f.deps), 0);
    assert.equal(f.wranglerCalls.length, 1);
  });

  test('最初は届かなくても、時間内に効けば 0', async () => {
    const f = fake({
      after: {
        oldHealth: (call) => (call === 1 ? unreachable() : moved),
        oldRoot: (call) => (call === 1 ? unreachable() : redirectTo(`${LEGACY_REDIRECT_TARGET}/`)),
      },
    });
    assert.equal(await deployLegacyRedirect(f.deps), 0);
  });

  test('十分に時間が経っても旧 URL が 404 のままなら 0 以外で、error に理由を出す', async () => {
    const f = fake({ after: { oldHealth: () => noWorker, oldRoot: () => noWorker } });
    const code = await deployLegacyRedirect(f.deps);
    assert.notEqual(code, 0);
    assert.ok(f.errors.length > 0, 'error に理由が出ていない');
    assert.ok(f.requests.filter((r) => r.afterDeploy).length > 1, '繰り返し確かめていない');
  });

  test('/ だけ 302 で /api/health が 404 のままなら効いたとしない', async () => {
    const f = fake({ after: { oldHealth: () => noWorker } });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.ok(f.errors.length > 0);
  });

  test('/api/health だけ 410 の moved で / が 404 のままなら効いたとしない', async () => {
    const f = fake({ after: { oldRoot: () => noWorker } });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.ok(f.errors.length > 0);
  });

  test('置いた後も旧 URL が本番の health のままなら効いたとしない', async () => {
    const f = fake({
      after: { oldHealth: () => health(), oldRoot: () => ({ status: 200, location: null, body: null }) },
    });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
  });

  test('/api/health が 410 でも code が moved でなければ効いたとしない', async () => {
    const f = fake({ after: { oldHealth: () => errorReply(410, 'not_found') } });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
  });

  test('/ が 301 なら効いたとしない', async () => {
    const f = fake({
      after: { oldRoot: () => ({ status: 301, location: `${LEGACY_REDIRECT_TARGET}/`, body: null }) },
    });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
  });

  test('/ が 302 でも Location が新しい URL の / でなければ効いたとしない', async () => {
    const f = fake({ after: { oldRoot: () => redirectTo(`${LEGACY_REDIRECT_TARGET}/aoba`) } });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
  });

  test('/ が 302 で Location が無ければ効いたとしない', async () => {
    const f = fake({ after: { oldRoot: () => ({ status: 302, location: null, body: null }) } });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
  });

  for (const location of [
    'https://evil.example/',
    `${LEGACY_REDIRECT_TARGET}.evil.example/`,
    'http://banmen.ucan-lab.workers.dev/',
    `${LEGACY_ORIGIN}/`,
    '//banmen.ucan-lab.workers.dev/',
    '/',
  ]) {
    test(`すり抜け: / の Location が ${location} なら効いたとしない`, async () => {
      const f = fake({ after: { oldRoot: () => redirectTo(location) } });
      assert.notEqual(await deployLegacyRedirect(f.deps), 0);
      assert.ok(f.errors.length > 0);
    });
  }

  test('すり抜け: 確かめは時間の上限で終わり、wrangler を2回呼ばない', async () => {
    const f = fake({ after: { oldHealth: () => unreachable(), oldRoot: () => unreachable() } });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.equal(f.wranglerCalls.length, 1);
    assert.ok(f.clock() <= RUNAWAY_MS);
  });
});
