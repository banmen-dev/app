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

// 呼び出し元で Issue 番号とサブドメインの形を検査する。
export function previewOrigin(number: string, subdomain: string): string {
  return `https://pr-${number}-scrum-guild-preview.${subdomain}.workers.dev`;
}
