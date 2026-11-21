import type { Page } from '@playwright/test';
import { openCatalog } from './design-samples.ts';
import { expect, test } from './fixtures.ts';
import { type A11Y_THEMES, applyTheme, findA11yViolations, formatA11yViolations } from './helpers.ts';

// カタログを開き、目次と全セクションの表示を確かめる。開いた後のページの例外を返す。
export async function openCatalogSections(page: Page): Promise<string[]> {
  const errors = await openCatalog(page);
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
  return errors;
}

export async function expectAccessibleCatalog(page: Page): Promise<void> {
  // 除外は設けず、カタログ全体を WCAG A/AA（コントラストを含む）で測る。
  const violations = await findA11yViolations(page);
  if (violations.length > 0) throw new Error(formatA11yViolations(violations));
}

export async function checkCatalogAccessibility(
  page: Page,
  width: number,
  theme: (typeof A11Y_THEMES)[number],
): Promise<void> {
  await page.setViewportSize({ width, height: 1000 });
  const errors = await test.step('カタログの全セクションを表示する', () => openCatalogSections(page));
  await test.step('テーマを適用する', () => applyTheme(page, theme));
  await test.step('カタログ全体を axe で検査する', () => expectAccessibleCatalog(page));
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  expect(errors).toEqual([]);
}
