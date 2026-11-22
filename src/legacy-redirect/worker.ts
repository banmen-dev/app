// 旧 URL を新しい URL へ送る Worker（wrangler.legacy-redirect.jsonc）。
// 画面の GET と HEAD は新しい URL の同じパスとクエリへ 302 で送る。/api、/api/ の下、GET と HEAD 以外は 410 の moved にする。
// 転送先は固定で、リクエストの Host などは見ない。Location に断片は付けない
import type { ErrorBody } from '../shared/errors.ts';

// 転送先。末尾の / は付けない
export const LEGACY_REDIRECT_TARGET = 'https://banmen.ucan-lab.workers.dev';

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
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
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if ((request.method !== 'GET' && request.method !== 'HEAD') || isApiPath(url.pathname)) return moved();
    // new URL(path, base) だと // で始まるパスが別のオリジンになるので、文字列でつなぐ
    return new Response(null, {
      status: 302,
      headers: { location: `${LEGACY_REDIRECT_TARGET}${url.pathname}${url.search}` },
    });
  },
};
