import { checkCatalogAccessibility } from './design-catalog-a11y.ts';
import { test } from './fixtures.ts';
import { A11Y_THEMES } from './helpers.ts';

// 各 assertion の待ちは延ばさず、カタログ全体の axe 検査は60秒以内で確かめる。
test.setTimeout(60_000);

const width = 1280;
for (const theme of A11Y_THEMES) {
  test(`見本のカタログの axe: ${width}px / ${theme}`, async ({ page }) => {
    await checkCatalogAccessibility(page, width, theme);
  });
}
