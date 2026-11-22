// PR のコードを実行する Builds に、本番アカウントの権限を渡さない。
export const PRODUCTION_CLOUDFLARE_ACCOUNT_ID = '71293a3c23974c311b4c82b3f977049b';
export const LEGACY_PREVIEW_SUBDOMAIN = 'ucan-lab';

export function isIsolatedPreviewAccount(accountId: string | undefined): accountId is string {
  return (
    typeof accountId === 'string' &&
    /^[0-9a-f]{32}$/i.test(accountId) &&
    accountId.toLowerCase() !== PRODUCTION_CLOUDFLARE_ACCOUNT_ID
  );
}

export function isPreviewSubdomain(subdomain: string | undefined): subdomain is string {
  return typeof subdomain === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain);
}

export function isIsolatedPreviewSubdomain(subdomain: string | undefined): subdomain is string {
  return isPreviewSubdomain(subdomain) && subdomain !== LEGACY_PREVIEW_SUBDOMAIN;
}

// プレビューの資源の名前はここだけで決める。D1、alias、URL の形は Worker の名前と D1 の接頭辞から作る。
// 2026-11-22 に scrum-guild-preview から改めた（docs/naming.md の「識別子」）。
export const PREVIEW_WORKER_NAME = 'banmen-preview';
// wrangler.preview-trigger.jsonc は定数を読めないので、テストが name との一致を確かめる。
export const PREVIEW_TRIGGER_WORKER_NAME = `${PREVIEW_WORKER_NAME}-trigger`;
export const PREVIEW_DATABASE_PREFIX = 'banmen-pr-';

// 名前は英小文字、数字、`-` だけなので、正規表現にそのまま埋め込める（テストが形を確かめる）。
// PREVIEW_ORIGIN_PATTERN のグループは 1 が Issue 番号、2 がサブドメイン。
export const PREVIEW_DATABASE_PATTERN = new RegExp(`^${PREVIEW_DATABASE_PREFIX}([1-9][0-9]*)$`);
export const PREVIEW_ORIGIN_PATTERN = new RegExp(
  `^https://pr-([1-9][0-9]*)-${PREVIEW_WORKER_NAME}\\.([a-z0-9-]+)\\.workers\\.dev$`,
);

export function previewDatabaseName(number: string): string {
  return `${PREVIEW_DATABASE_PREFIX}${number}`;
}

export function isPreviewDatabaseName(name: string): boolean {
  return name.startsWith(PREVIEW_DATABASE_PREFIX);
}

// Workers の alias の名前。workers.dev のラベルは 63 文字まで。
export function previewAlias(number: string): string {
  return `pr-${number}-${PREVIEW_WORKER_NAME}`;
}

// 呼び出し元で Issue 番号とサブドメインの形を検査する。
export function previewOrigin(number: string, subdomain: string): string {
  return `https://${previewAlias(number)}.${subdomain}.workers.dev`;
}
