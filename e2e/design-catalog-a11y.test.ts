import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, findA11yViolations, formatA11yViolations } from './helpers.ts';

// アプリの配信対象外の見本を、既存の design-catalog.test.ts と同じ方法で開く。seed の認証は使わない。
// #1237: 全セクションの確認をまとめ、ブラウザとの往復で検査時間を使い切らない。
// カタログ全体の axe 検査を60秒以内で確かめる。各 assertion の待ちは延ばさない。
test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const files: Record<string, string> = {
    'index.html': 'text/html',
    'tokens.css': 'text/css',
    'components.css': 'text/css',
    'icons.js': 'text/javascript',
    'art.js': 'text/javascript',
    'sample-data.js': 'text/javascript',
    'kit.js': 'text/javascript',
    'image-crop.js': 'text/javascript',
  };
  await page.route('**/__design-catalog/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    const contentType = files[name];
    if (!contentType) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ contentType, body: readFileSync(new URL(`../design/${name}`, import.meta.url)) });
  });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    await page.route(`https://${host}/**`, (route) => route.fulfill({ body: '' }));
  }
});

async function openCatalog(page: Page): Promise<void> {
  await page.goto('/__design-catalog/index.html');
  await expect(page.getByRole('heading', { level: 1, name: 'デザインシステム', exact: true })).toBeVisible();
  const links = page.locator('#toc a');
  const hrefs = await links.evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
  expect(hrefs.length, '目次が空').toBeGreaterThan(0);
  for (const href of hrefs) expect(href, '目次の参照先が不正').toMatch(/^#.+/);
  expect(new Set(hrefs).size, '目次の参照先が重複する').toBe(hrefs.length);
  // 目次との1対1の対応と全件の表示を保ち、セクションごとの API 呼び出しを避ける。
  const sections = page.locator('#main > .cat-block');
  expect(
    await sections.evaluateAll((elements) => elements.map((element) => `#${element.id}`)),
    '目次とセクションが対応しない',
  ).toEqual(hrefs);
  await expect(page.locator('#main > .cat-block:visible'), 'セクションが非表示').toHaveCount(hrefs.length);
}

for (const [name, body] of [
  ['目次が空', '<main id="main"></main>'],
  [
    '目次の参照先が不正',
    '<nav id="toc"><a href="other.html">見本</a></nav><main id="main"><section class="cat-block" id="one">見本</section></main>',
  ],
  [
    '目次とセクションが対応しない',
    '<nav id="toc"><a href="#missing">見本</a></nav><main id="main"><section class="cat-block" id="one">見本</section></main>',
  ],
  [
    '目次の参照先が重複する',
    '<nav id="toc"><a href="#one">見本1</a><a href="#one">見本2</a></nav><main id="main"><section class="cat-block" id="one">見本1</section><section class="cat-block" id="one">見本2</section></main>',
  ],
  [
    'セクションが非表示',
    '<nav id="toc"><a href="#one">見本</a></nav><main id="main"><section class="cat-block" id="one" hidden>見本</section></main>',
  ],
]) {
  test(`カタログの表示確認は${name}なら失敗する`, async ({ page }) => {
    await page.route('**/__design-catalog/index.html', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>デザインシステム</h1>${body}` }),
    );
    await expect(openCatalog(page)).rejects.toThrow(name);
  });
}

async function expectAccessibleCatalog(page: Page): Promise<void> {
  // 除外は設けず、カタログ全体を WCAG A/AA（コントラストを含む）で測る。
  const violations = await findA11yViolations(page);
  if (violations.length > 0) throw new Error(formatA11yViolations(violations));
}

// layout-narrow*.test.ts は本番の画面が対象なので、見本の狭幅もここで測る。
for (const width of [1280, 390]) {
  for (const theme of A11Y_THEMES) {
    test(`見本のカタログの axe: ${width}px / ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await test.step('カタログの全セクションを表示する', () => openCatalog(page));
      await test.step('テーマを適用する', () => applyTheme(page, theme));
      await test.step('カタログ全体を axe で検査する', () => expectAccessibleCatalog(page));
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });
  }
}

test('壊したカタログの無名ボタンと低コントラスト文字で、検査が落ちる', async ({ page }) => {
  await openCatalog(page);
  await applyTheme(page, A11Y_THEMES[0]);
  await page.locator('#main').evaluate((main) => {
    const broken = document.createElement('div');
    broken.innerHTML =
      '<button type="button" id="broken-button"></button>' +
      '<p id="broken-contrast" style="color:#999;background:#aaa">Faint text</p>';
    main.prepend(broken);
  });
  // 別の既存違反による失敗では足りず、仕込んだ2つを検査の入口が報告することを確かめる。
  const checked = expectAccessibleCatalog(page);
  await expect(checked).rejects.toThrow(/- button-name: #broken-button/);
  await expect(checked).rejects.toThrow(/- color-contrast: #broken-contrast/);
});
