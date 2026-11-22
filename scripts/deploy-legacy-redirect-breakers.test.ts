// デプロイのスクリプト（scripts/deploy-legacy-redirect.ts）を崩す手口。scripts/deploy-legacy-redirect.test.ts と重ならないものだけを置く
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEGACY_REDIRECT_TARGET } from '../src/legacy-redirect/worker.ts';
import {
  deployLegacyRedirect,
  LEGACY_ORIGIN,
  VERIFY_INTERVAL_MS,
  VERIFY_TIMEOUT_MS,
  type LegacyRedirectDeps,
} from './deploy-legacy-redirect.ts';

type Reply = { status: number; location: string | null; body: unknown };

const health: Reply = {
  status: 200,
  location: null,
  body: { status: 'ok', database: 'ok', credentialKeys: 'ok', version: 'abc1234' },
};
const noWorker: Reply = { status: 404, location: null, body: null };

// 置く前は旧 URL が 404、置いた後も 404 のまま（転送が効かない）。時計は clock(t) で、t は sleep と問い合わせで進む実際の経過
function fake(options: { clock: (elapsed: number, deployed: boolean) => number; sleepAdvances: boolean }) {
  let elapsed = 0;
  let deployed = false;
  let sleptMs = 0;
  let checks = 0;
  const errors: string[] = [];
  const deps: LegacyRedirectDeps = {
    request: async (url) => {
      elapsed += 100;
      // 1日分を超えたら、上限を見ていないとみなして投げる（テストが止まらないのを防ぐ）
      if (elapsed > 24 * 60 * 60 * 1000) throw new Error('時間の上限を過ぎても終わらない');
      if (url === `${LEGACY_REDIRECT_TARGET}/api/health`) return health;
      if (deployed && url === `${LEGACY_ORIGIN}/`) checks++;
      return noWorker;
    },
    wrangler: () => {
      deployed = true;
      return { status: 0 };
    },
    sleep: async (ms) => {
      sleptMs += ms;
      if (options.sleepAdvances) elapsed += ms;
    },
    now: () => options.clock(elapsed, deployed),
    log: () => {},
    error: (message) => {
      errors.push(message);
    },
  };
  return { deps, errors, sleptMs: () => sleptMs, elapsed: () => elapsed, checks: () => checks };
}

describe('崩し: 置いた後の確かめの時間の上限', () => {
  // Issue #1421「置いた後は転送が効くまで上限つきで確かめる」、docs/operations.md「1分まで確かめ直す」。
  // 入口の now は Date.now で、壁時計は NTP などで戻りうる（単調ではない）。時計が1時間戻っても、確かめは1分ほどで終わる
  test('置いた直後に時計が1時間戻っても、確かめは上限の時間ほどで終わる', async () => {
    const hour = 60 * 60 * 1000;
    const f = fake({
      sleepAdvances: true,
      // 置く前は 10:00 ちょうど、置いて最初の now を読んだ後に 1時間戻る
      clock: (elapsed, deployed) => (deployed && elapsed > 300 ? 10 * hour + elapsed - hour : 10 * hour + elapsed),
    });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.ok(f.errors.length > 0);
    assert.ok(
      f.elapsed() <= VERIFY_TIMEOUT_MS + 2 * VERIFY_INTERVAL_MS,
      `確かめに ${Math.round(f.elapsed() / 1000)} 秒かかった（上限は ${VERIFY_TIMEOUT_MS / 1000} 秒）`,
    );
  });

  // sleep が待たずに返っても（時計だけは本当に進む）、now の上限で終わり、wrangler を呼び直さない
  test('sleep が早く返っても、時計の上限で終わり 0 以外', async () => {
    const f = fake({ sleepAdvances: false, clock: (elapsed) => elapsed });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.ok(f.errors.length > 0);
    assert.ok(f.elapsed() <= VERIFY_TIMEOUT_MS + VERIFY_INTERVAL_MS);
    assert.ok(f.checks() > 1, '確かめ直していない');
  });
});
