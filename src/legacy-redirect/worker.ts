// 旧 URL を新しい URL へ送る Worker（wrangler.legacy-redirect.jsonc）。

// 転送先。末尾の / は付けない
export const LEGACY_REDIRECT_TARGET = 'https://banmen.ucan-lab.workers.dev';

export default {
  fetch(_request: Request): Response {
    throw new Error('未実装');
  },
};
