// デプロイのスクリプト（scripts/deploy-legacy-redirect.ts）と、それが出す設定（wrangler.legacy-redirect.jsonc）を崩す手口の3周目。
// scripts/deploy-legacy-redirect.test.ts、scripts/deploy-legacy-redirect-breakers.test.ts、
// scripts/deploy-legacy-redirect-breakers-2.test.ts と重ならないものだけを置く
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import ts from 'typescript';
import { LEGACY_REDIRECT_TARGET } from '../src/legacy-redirect/worker.ts';
import {
  deployLegacyRedirect,
  LEGACY_ORIGIN,
  VERIFY_TIMEOUT_MS,
  type LegacyRedirectDeps,
} from './deploy-legacy-redirect.ts';

type Reply = { status: number; location: string | null; body: unknown };

function readJsonc(file: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  assert.equal(parsed.error, undefined, `${file} を読めない`);
  return parsed.config as Record<string, unknown>;
}

// 応答の本文に混ぜる、ログに出てはいけない値（架空）
const SECRET = 'sentinel-body-4b1e2d';

describe('崩し: log と error に問い合わせの本文を出さない', () => {
  // CLAUDE.md「ログに本文、取り込んだ内容、認証情報を出さない」。止まる理由は状態と Location だけで足り、本文は出さない
  function run(replies: (url: string, deployed: boolean) => Reply) {
    let deployed = false;
    let t = 0;
    const out: string[] = [];
    const deps: LegacyRedirectDeps = {
      request: async (url) => {
        t += 100;
        return replies(url, deployed);
      },
      wrangler: () => {
        deployed = true;
        return { status: 0 };
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    };
    return { deps, out };
  }

  const leakyHealth: Reply = {
    status: 200,
    location: null,
    body: { status: 'ok', database: 'ok', credentialKeys: 'ok', version: SECRET, extra: SECRET },
  };
  const leakyError = (status: number): Reply => ({
    status,
    location: null,
    body: { error: { code: 'internal', message: SECRET, details: { token: SECRET } } },
  });

  test('新しい URL が本文つきの 503 を返して止まっても、本文を出さない', async () => {
    const f = run(() => leakyError(503));
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.ok(f.out.length > 0);
    for (const m of f.out) assert.ok(!m.includes(SECRET), m);
  });

  test('旧 URL が本番の health（版つき）を返して止まっても、本文を出さない', async () => {
    const f = run(() => leakyHealth);
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.ok(f.out.length > 0);
    for (const m of f.out) assert.ok(!m.includes(SECRET), m);
  });

  test('置いた後の確かめが効かないまま終わっても、本文を出さない', async () => {
    const f = run((url, deployed) => {
      if (url === `${LEGACY_REDIRECT_TARGET}/api/health`) return leakyHealth;
      if (!deployed) return { status: 404, location: null, body: { error: { message: SECRET } } };
      if (url === `${LEGACY_ORIGIN}/`) return { status: 302, location: `${LEGACY_REDIRECT_TARGET}/`, body: null };
      return leakyError(500);
    });
    assert.notEqual(await deployLegacyRedirect(f.deps), 0);
    assert.ok(f.out.length > 1);
    for (const m of f.out) assert.ok(!m.includes(SECRET), m);
  });
});

describe('崩し: 旧 URL の Worker の呼び出しごとのログ', () => {
  // 本番の wrangler.jsonc は、呼び出しごとのログが URL のパスとクエリを残すので invocation_logs を切っている
  // （「後で OAuth の code や招待の秘密を URL で受けるとログに残るので切り」）。
  // 旧 URL には、名前を変える前に始めたログインの戻り（/api/auth/<手段>/callback?code=…&state=…）が届きうる。
  // CLAUDE.md「ログに本文、取り込んだ内容、認証情報を出さない」。転送用の設定に置かないと、旧名の Worker の
  // ダッシュボードの設定（既定や人の切り替え）しだいでクエリの code がログに残る
  test('wrangler.legacy-redirect.jsonc は呼び出しごとのログを切るか、ログそのものを切る', () => {
    const config = readJsonc('wrangler.legacy-redirect.jsonc');
    const observability = config.observability as
      { enabled?: boolean; logs?: { enabled?: boolean; invocation_logs?: boolean } } | undefined;
    assert.ok(observability !== undefined, 'observability を設定に置いていない（ダッシュボードの設定しだいになる）');
    const off =
      observability.enabled === false ||
      observability.logs?.enabled === false ||
      observability.logs?.invocation_logs === false;
    assert.ok(off, `呼び出しごとのログが切れていない: ${JSON.stringify(observability)}`);
  });
});

describe('崩し: 置いた後の確かめの1回の問い合わせが、上限の1分を延ばす', () => {
  // docs/operations.md「1分（5秒おきに13回）まで確かめ直す」。scripts/deploy.ts の煙のテストは、1回の打ち切りを
  // 期限までの残りで縮めて上限を超えない。ここでは問い合わせが打ち切りいっぱいまで待ってから届かない（投げる）とき、
  // wrangler の後の確かめが VERIFY_TIMEOUT_MS のうちに終わり、各問い合わせの timeoutMs が正で残り時間以下であることを見る
  test('問い合わせが毎回 timeoutMs だけ待って届かなくても、確かめは VERIFY_TIMEOUT_MS を超えない', async () => {
    let t = 0;
    let deployedAt: number | undefined;
    const overruns: string[] = [];
    const deps: LegacyRedirectDeps = {
      request: async (url, timeoutMs) => {
        if (deployedAt === undefined) {
          t += 100;
          if (url === `${LEGACY_REDIRECT_TARGET}/api/health`) {
            return {
              status: 200,
              location: null,
              body: { status: 'ok', database: 'ok', credentialKeys: 'ok', version: 'abc1234' },
            };
          }
          return { status: 404, location: null, body: null };
        }
        const remaining = deployedAt + VERIFY_TIMEOUT_MS - t;
        if (!(timeoutMs > 0) || timeoutMs > remaining) {
          overruns.push(`${(t - deployedAt) / 1000}秒の時点で timeoutMs ${timeoutMs}（残り ${remaining}）`);
        }
        // 1日分を超えたら、上限を見ていないとみなして止める
        if (t - deployedAt > 24 * 60 * 60 * 1000) throw new Error('時間の上限を過ぎても終わらない');
        t += timeoutMs;
        throw new Error('The operation was aborted due to timeout');
      },
      wrangler: () => {
        deployedAt = t;
        return { status: 0 };
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      log: () => {},
      error: () => {},
    };
    assert.notEqual(await deployLegacyRedirect(deps), 0);
    assert.ok(deployedAt !== undefined);
    assert.deepEqual(overruns, [], '残り時間を超える打ち切りで問い合わせた');
    assert.ok(
      t - deployedAt <= VERIFY_TIMEOUT_MS,
      `置いた後の確かめに ${(t - deployedAt) / 1000} 秒かかった（上限は ${VERIFY_TIMEOUT_MS / 1000} 秒）`,
    );
  });
});
