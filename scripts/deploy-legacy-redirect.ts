// 旧 URL に転送用の Worker を置く（node scripts/deploy-legacy-redirect.ts）。
// 人が当日（#1423）に、本番の Worker が名前を変えて旧 URL を空けた後で、手元から打つ。Workers Builds にはつながない。
// 手順は docs/operations.md の「旧 URL の転送」
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { LEGACY_REDIRECT_TARGET } from '../src/legacy-redirect/worker.ts';
import { isErrorBody } from '../src/shared/errors.ts';
import { isHealth } from '../src/shared/health.ts';

// 転送用の Worker を置く旧 URL。本番の Worker が名前を変えて空けた後にだけ置く
export const LEGACY_ORIGIN = 'https://scrum-guild.ucan-lab.workers.dev';

// 置いた後に効くまで待つ上限と間隔。1回の問い合わせの上限
export const VERIFY_TIMEOUT_MS = 60_000;
export const VERIFY_INTERVAL_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 10_000;
// 壁時計は戻りうる（now は Date.now）ので、時計の上限に加えて回数でも打ち切る。最初の1回と、間隔ごとの1回
export const VERIFY_MAX_ATTEMPTS = VERIFY_TIMEOUT_MS / VERIFY_INTERVAL_MS + 1;

const WRANGLER_CONFIG = 'wrangler.legacy-redirect.jsonc';

export type LegacyRedirectDeps = {
  // GET して、状態、Location、JSON の本文（読み切れて JSON でなければ null）を返す。リダイレクトは辿らない。
  // 届かないときと、本文を読み切れないときは投げる
  request: (url: string, timeoutMs: number) => Promise<{ status: number; location: string | null; body: unknown }>;
  // wrangler を引数で動かし、終了コードを返す
  wrangler: (args: string[]) => { status: number };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  error: (message: string) => void;
};

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMoved(reply: { status: number; body: unknown }): boolean {
  return reply.status === 410 && isErrorBody(reply.body) && reply.body.error.code === 'moved';
}

// 置いた後の旧 URL が転送を始めているか。始めていなければ、その理由を返す。
// 1回の問い合わせの打ち切りは、期限までの残りで縮める（上限の VERIFY_TIMEOUT_MS を延ばさない）。残りが無ければ問い合わせない
async function checkRedirecting(deps: LegacyRedirectDeps, deadline: number): Promise<string | undefined> {
  const timeoutMs = () => Math.min(REQUEST_TIMEOUT_MS, deadline - deps.now());
  try {
    if (timeoutMs() <= 0) return '確かめの上限に達しました';
    const root = await deps.request(`${LEGACY_ORIGIN}/`, timeoutMs());
    if (root.status !== 302 || root.location !== `${LEGACY_REDIRECT_TARGET}/`) {
      return `旧 URL の / が 302 で ${LEGACY_REDIRECT_TARGET}/ へ送っていません（状態 ${root.status}、Location ${root.location ?? '無し'}）`;
    }
    if (timeoutMs() <= 0) return '確かめの上限に達しました';
    const api = await deps.request(`${LEGACY_ORIGIN}/api/health`, timeoutMs());
    if (!isMoved(api)) return `旧 URL の /api/health が 410 の moved ではありません（状態 ${api.status}）`;
    return undefined;
  } catch (err) {
    return `旧 URL に届きません（${describeError(err)}）`;
  }
}

// 終了コードを返す。0 は置いて確かめた、ほかは止まったか確かめられなかった
export async function deployLegacyRedirect(deps: LegacyRedirectDeps): Promise<number> {
  // 新しい URL が動いていなければ、転送先が無いので置かない
  try {
    const health = await deps.request(`${LEGACY_REDIRECT_TARGET}/api/health`, REQUEST_TIMEOUT_MS);
    if (health.status !== 200 || !isHealth(health.body)) {
      deps.error(
        `新しい URL の /api/health が health を返していません（状態 ${health.status}）。転送用の Worker は置きません`,
      );
      return 1;
    }
  } catch (err) {
    deps.error(`新しい URL に届きません（${describeError(err)}）。転送用の Worker は置きません`);
    return 1;
  }

  // 旧 URL を本番の Worker が使っている間は、上書きしないために置かない。404 か、置いた後のやり直しの 410 の moved だけ進む
  try {
    const old = await deps.request(`${LEGACY_ORIGIN}/api/health`, REQUEST_TIMEOUT_MS);
    // Worker の無い名前の 404 は JSON でない。API のエラーの形の 404 は、本番の Worker が答えている
    const noWorker = old.status === 404 && !isErrorBody(old.body);
    if (!noWorker && !isMoved(old)) {
      deps.error(
        `旧 URL の /api/health が Worker の無い 404（本文が JSON のエラーでない）でも 410 の moved でもありません（状態 ${old.status}）。本番の Worker が残っているおそれがあるので、転送用の Worker は置きません`,
      );
      return 1;
    }
  } catch (err) {
    deps.error(`旧 URL に届きません（${describeError(err)}）。転送用の Worker は置きません`);
    return 1;
  }

  const deployed = deps.wrangler(['deploy', '-c', WRANGLER_CONFIG]);
  if (deployed.status !== 0) {
    deps.error(`wrangler deploy に失敗しました（終了コード ${deployed.status}）。転送が効いたかは確かめていません`);
    return 1;
  }

  const started = deps.now();
  const deadline = started + VERIFY_TIMEOUT_MS;
  let reason: string | undefined;
  for (let attempt = 1; ; attempt++) {
    reason = await checkRedirecting(deps, deadline);
    if (reason === undefined) {
      deps.log(`旧 URL の転送の確認: ${attempt}回目で効きました（${Math.round((deps.now() - started) / 1000)}秒）`);
      return 0;
    }
    deps.log(`旧 URL の転送の確認: ${attempt}回目はまだです（${reason}）`);
    const remaining = deadline - deps.now();
    if (remaining <= 0 || attempt >= VERIFY_MAX_ATTEMPTS) break;
    await deps.sleep(Math.min(VERIFY_INTERVAL_MS, remaining));
    // 待っているうちに期限が来たら、問い合わせずに打ち切る
    if (deadline - deps.now() <= 0) break;
  }
  deps.error(
    `旧 URL の転送の確認: ${VERIFY_TIMEOUT_MS / 1000}秒待っても効きませんでした（${reason}）。転送用の Worker は置いています。Cloudflare のダッシュボードで旧 URL の Worker を確かめてください`,
  );
  return 1;
}

// 入口が使う本物の問い合わせ（deploy-legacy-redirect-review.test.ts が手元の HTTP サーバーで確かめる）
export async function fetchReply(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; location: string | null; body: unknown }> {
  const res = await fetch(url, {
    // リダイレクトは辿らない。Location をそのまま確かめる
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  // 本文を読み切れなければ投げる（届かないとして止まる）。途中で切れた本文を「JSON でない」と取り違え、
  // Worker の無い名前の 404 とみなして本番の Worker を上書きしないため。読み切れて JSON でなければ null
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, location: res.headers.get('location'), body };
}

// デプロイのコマンドは pnpm の外で動くので、node_modules/.bin が PATH に無い
// どのディレクトリから打っても、このリポジトリの wrangler と設定（-c の相対パス）を使うよう、ルートで動かす
const repoRoot = path.join(import.meta.dirname, '..');
const wranglerBin = path.join(repoRoot, 'node_modules', '.bin', 'wrangler');

// import しても入口が動かないよう、直に動かしたときだけ呼ぶ（テストや別のスクリプトからの import を守る）。
// import.meta.main が無い Node（古い版）では、常に偽とみなすと何もしないまま成功に見えるので、理由を出して失敗させる
if (typeof import.meta.main !== 'boolean') {
  console.error(
    'import.meta.main が使えない Node です。import.meta.main が使える Node（.node-version の版）で動かしてください',
  );
  process.exit(1);
}

if (import.meta.main) {
  const status = await deployLegacyRedirect({
    request: fetchReply,
    wrangler: (args) => {
      // 標準入力を閉じ、確認を待って止まらないようにする
      const result = spawnSync(wranglerBin, args, { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] });
      if (result.error) {
        console.error(`wrangler を起動できませんでした: ${result.error.message}`);
        return { status: 1 };
      }
      return { status: result.status ?? 1 };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  });
  process.exit(status);
}
