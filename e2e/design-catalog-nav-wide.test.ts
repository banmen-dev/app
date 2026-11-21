import { checkCatalogNavWrapping } from './design-catalog-nav-wrapping.ts';
import { test } from './fixtures.ts';

// 幅ごとに1件にし、テーマはページを開いたまま切り替えて確かめる（カタログを読み直すのは幅ごとに1回。テーマごとに分けると
// 18 回読み直して e2e で2番目に重いファイルになっていた）。どのテーマで落ちたかは test.step の名前で分かる
for (const width of [1280, 1024, 761]) {
  test(`長い名前のメニューの見本: ${width}px / 3つのテーマ`, async ({ page }) => {
    // 3テーマの比較と既存幅との再比較は、CIのtraceで合計30秒近く掛かる。各検査の待ちは増やさず、全体に余裕を持たせる。
    test.setTimeout(60_000);
    await checkCatalogNavWrapping(page, width);
  });
}
