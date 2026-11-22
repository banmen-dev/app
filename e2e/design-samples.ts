import { existsSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export const CATALOG_THEMES = ['simple_light', 'simple_dark'] as const;

// 見本（design/）はアプリの配信対象外なので、e2e では /__design-catalog/ の下へ design/ の直下のファイルをそのまま返す。
// 返すのは直下にある HTML、CSS、JS だけにし、下のフォルダ（brand/ の画像、fonts/）、ほかの拡張子、無いファイルは 404 にする。
// 空のパス（/__design-catalog/）は index.html を返す。
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
};

const PREFIX = '/__design-catalog/';

// ルートを登録したページ。同じページで開き直しても登録を重ねない。
// 先に登録しておけば、後からテストで足したルート（見本の HTML の差し替え）が優先される（Playwright は後に登録したルートを先に当てる）
const routed = new WeakSet<Page>();

export async function routeDesignCatalog(page: Page): Promise<void> {
  if (routed.has(page)) return;
  await page.route(`**${PREFIX}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const name = pathname.slice(pathname.indexOf(PREFIX) + PREFIX.length) || 'index.html';
    const extension = /^[^/]+\.([a-z]+)$/.exec(name)?.[1];
    const contentType = extension && Object.hasOwn(CONTENT_TYPES, extension) ? CONTENT_TYPES[extension] : undefined;
    const file = new URL(`../design/${name}`, import.meta.url);
    if (!contentType || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ contentType, body: readFileSync(file) });
  });
  // CI のネットワークやフォント取得の成否で寸法が変わらないようにする。
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    await page.route(`https://${host}/**`, (route) => route.fulfill({ body: '' }));
  }
  routed.add(page);
}

// 見本のファイル（既定はカタログの index.html）を開き、開いた後に起きたページの例外を集める配列を返す。
// 開いたテストは、終わりに expect(errors).toEqual([]) で例外が無いことを確かめる
export async function openCatalog(page: Page, file = 'index.html'): Promise<string[]> {
  await routeDesignCatalog(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${PREFIX}${file}`);
  return errors;
}
