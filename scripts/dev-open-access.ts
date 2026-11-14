// Access の秘密は許可したプレビューの同一 origin にだけ付ける。
import type { BrowserContext } from '@playwright/test';
import { isPreviewOrigin, type DevOpenTarget } from './dev-open-target.ts';

export function accessHeaders(
  url: string,
  target: DevOpenTarget,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (!target.remoteOrigin || !isPreviewOrigin(target.remoteOrigin) || target.origin !== target.remoteOrigin) return {};
  if (new URL(url).origin !== target.remoteOrigin) return {};
  if (!env.CF_ACCESS_CLIENT_ID?.trim() || !env.CF_ACCESS_CLIENT_SECRET?.trim()) {
    throw new Error('プレビューには CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET の両方が必要');
  }
  return { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET };
}

export async function installDevOpenAccess(
  context: Pick<BrowserContext, 'route'>,
  target: DevOpenTarget,
  env: Record<string, string | undefined>,
): Promise<void> {
  if (!target.remoteOrigin) return;
  // context の extraHTTPHeaders は外部資産やリダイレクト先にも送られるので使わない。
  await context.route('**/*', async (route) => {
    const headers = accessHeaders(route.request().url(), target, env);
    if (Object.keys(headers).length === 0) {
      await route.continue();
      return;
    }
    try {
      // continue({headers}) もリダイレクト先へヘッダーを引き継ぐ。1応答ずつブラウザに返し、次の URL で再判定する。
      const response = await route.fetch({ headers: { ...route.request().headers(), ...headers }, maxRedirects: 0 });
      await route.fulfill({ response });
    } catch {
      // Playwright のエラーにはリクエストヘッダーが含まれうるため出力しない。
      await route.abort().catch(() => undefined);
    }
  });
}
