import { checkCatalogAccessibility } from './design-catalog-a11y.ts';
import { test } from './fixtures.ts';
import { A11Y_THEMES } from './helpers.ts';

// 各 assertion の待ちは延ばさず、カタログ全体の axe 検査は60秒以内で確かめる。
test.setTimeout(60_000);

// layout-narrow*.test.ts は本番の画面が対象なので、見本の狭幅もここで測る。
const width = 390;
for (const theme of A11Y_THEMES) {
  test(`見本のカタログの axe: ${width}px / ${theme}`, async ({ page }) => {
    await checkCatalogAccessibility(page, width, theme);
  });
}
