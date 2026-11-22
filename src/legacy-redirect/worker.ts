// 旧 URL を新しい URL へ送る Worker（wrangler.legacy-redirect.jsonc）。
// 画面の GET と HEAD は新しい URL の同じパスとクエリへ 302 で送る。/api、/api/ の下、GET と HEAD 以外は 410 の moved にする。
// 転送先は固定で、リクエストの Host などは見ない。Location に断片は付けない。
// 転送先を差し替えたり Worker を外したりした後に古い応答を使わせないよう、どちらもキャッシュさせない
import type { ErrorBody } from '../shared/errors.ts';

// 転送先。末尾の / は付けない
export const LEGACY_REDIRECT_TARGET = 'https://banmen.ucan-lab.workers.dev';

// 新しい URL の Hono は、パスの百分率符号を decodeURI で解いてから振り分ける（%25 は残す）。
// 解けない並びはそのまま残す（Hono の tryDecodeURI と同じ）。/%61pi/health も API への要求として扱うため、解いた形で判定する。
// 資産の振り分け（run_worker_first）が符号を解くかは確かめていないが、解かずに画面へ届くパスも 410 にする側に倒す
function tryDecodeURI(path: string): string {
  const input = path.includes('%25') ? path.replaceAll('%25', '%2525') : path;
  try {
    return decodeURI(input);
  } catch {
    return input.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
}

function isApiPath(pathname: string): boolean {
  const decoded = tryDecodeURI(pathname);
  return [pathname, decoded].some((p) => p === '/api' || p.startsWith('/api/'));
}

function moved(): Response {
  const body: ErrorBody = {
    error: {
      code: 'moved',
      message: `This service has moved to ${LEGACY_REDIRECT_TARGET}. Use the new URL.`,
      details: { location: LEGACY_REDIRECT_TARGET },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 410,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if ((request.method !== 'GET' && request.method !== 'HEAD') || isApiPath(url.pathname)) return moved();
    // new URL(path, base) だと // で始まるパスが別のオリジンになるので、文字列でつなぐ
    return new Response(null, {
      status: 302,
      headers: { location: `${LEGACY_REDIRECT_TARGET}${url.pathname}${url.search}`, 'cache-control': 'no-store' },
    });
  },
};
