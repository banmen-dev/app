// 左のメニューの右の境目で幅を変え、ダブルクリックで閉じる（#1513）。
// ドラッグ、下限と上限、札、ダブルクリックで閉じて前の幅で開く、矢印キー、読み直しと最初の読み込みの骨組みの幅、
// 細い窓の上限、指だけの端末で境目を出さないこと、4つの見た目（2つのテーマ × 2つの幅）の axe を確かめる
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, findA11yViolations, signIn, waitForSettled } from './helpers.ts';

const today = '/aoba';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'member');
});

const separator = (page: Page) => page.getByRole('separator', { name: 'メニューの幅' });

// 覚えた幅と開閉の状態を消してから開く
async function openFresh(page: Page, width = 1280, stored: string | null = null): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(today);
  await page.evaluate((value) => {
    localStorage.removeItem('sg-nav-collapsed');
    if (value === null) localStorage.removeItem('sg-nav-width');
    else localStorage.setItem('sg-nav-width', value);
  }, stored);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
}

// 境目の真ん中を掴み、dx だけ横へ動かして離す
async function drag(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error('境目の位置が取れない');
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 200);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

async function focusByTab(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 60 && !(await target.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

test('境目をドラッグすると幅が変わり、下限と上限で止まり、読み直しても最初の骨組みから同じ幅で出る', async ({
  page,
}) => {
  await openFresh(page);
  const binding = page.locator('.app > .binding');
  const handle = separator(page);
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-valuenow', '240');
  await expect(handle).toHaveAttribute('aria-valuemin', '200');
  await expect(handle).toHaveAttribute('aria-valuemax', '480');
  await expect(binding).toHaveJSProperty('offsetWidth', 240);

  // ホバーで札が出る
  await handle.hover();
  await expect(handle.locator('.nav-resize-tip')).toBeVisible();
  await expect(handle.locator('.nav-resize-tip')).toHaveText('ダブルクリックで閉じる');

  await drag(page, handle, 100);
  await expect(binding).toHaveJSProperty('offsetWidth', 340);
  await expect(handle).toHaveAttribute('aria-valuenow', '340');
  expect(await page.evaluate(() => localStorage.getItem('sg-nav-width'))).toBe('340');
  // 本文は綴じの右から始まる
  expect((await page.locator('.sheet').boundingBox())!.x).toBeCloseTo(340, 0);

  // 下限より細くしても閉じず、200px で止まる
  await drag(page, handle, -400);
  await expect(binding).toHaveJSProperty('offsetWidth', 200);
  await expect(page.locator('.app')).not.toHaveAttribute('data-nav-collapsed', 'true');
  // 上限（1280px では min(480px, 40vw) = 480px）で止まる
  await drag(page, handle, 600);
  await expect(binding).toHaveJSProperty('offsetWidth', 480);
  await expect(handle).toHaveAttribute('aria-valuenow', '480');

  // 読み直しても保ち、最初の読み込みの骨組み（static/boot-shape.js）も同じ幅を html に当てる
  await page.reload();
  await expect(binding).toHaveJSProperty('offsetWidth', 480);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--nav-width'))).toBe('480px');
});

test('最初の読み込みの骨組みの左の列は、覚えた幅で出る', async ({ page }) => {
  await openFresh(page, 1280, '320');
  // 骨組みの間を保つため、組織の読み込みを止めたまま開き直す
  await page.route('**/api/**', () => undefined);
  await page.goto(today, { waitUntil: 'commit' });
  const frame = page.locator('#boot-loading .boot-binding');
  await expect(frame).toBeVisible({ timeout: 5000 });
  await expect(frame).toHaveJSProperty('offsetWidth', 320);
});

test('境目をダブルクリックすると閉じ、帯の開閉のボタンで開くと前の幅で戻る', async ({ page }) => {
  await openFresh(page, 1280, '300');
  const binding = page.locator('.app > .binding');
  await expect(binding).toHaveJSProperty('offsetWidth', 300);
  await separator(page).dblclick();
  await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(binding).toBeHidden();
  // 綴じの中にあったフォーカスは、開閉のボタンへ移す
  const expand = page.getByRole('button', { name: 'メニューを開く' });
  await expect(expand).toBeFocused();
  await expand.click();
  await expect(binding).toHaveJSProperty('offsetWidth', 300);
  expect(await page.evaluate(() => localStorage.getItem('sg-nav-width'))).toBe('300');
});

test('キーボードで境目に移り、左右の矢印キーで幅を変え、読み上げの値が今の幅になり、Enter で閉じる', async ({
  page,
}) => {
  await openFresh(page);
  const binding = page.locator('.app > .binding');
  const handle = separator(page);
  await focusByTab(page, handle);
  await expect(handle.locator('.nav-resize-tip')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '256');
  await expect(binding).toHaveJSProperty('offsetWidth', 256);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '224');
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '200');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '480');
  expect(await page.evaluate(() => localStorage.getItem('sg-nav-width'))).toBe('480');
  await page.keyboard.press('Enter');
  await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(page.getByRole('button', { name: 'メニューを開く' })).toBeFocused();
});

test('細い窓では、覚えた幅が上限を超えても 40vw で止め、読み上げの値も合わせる', async ({ page }) => {
  await openFresh(page, 800, '480');
  const handle = separator(page);
  await expect(page.locator('.app > .binding')).toHaveJSProperty('offsetWidth', 320);
  await expect(handle).toHaveAttribute('aria-valuenow', '320');
  await expect(handle).toHaveAttribute('aria-valuemax', '320');
  // 覚えた幅は残し、広い窓に戻すと覚えた幅で出す
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('.app > .binding')).toHaveJSProperty('offsetWidth', 480);
  await expect(handle).toHaveAttribute('aria-valuenow', '480');
});

// 指だけの端末では境目を出さない（#1513。人が「開閉だけ出す」と決めた）
test.describe('ホバーのできない端末（1024px の指のタブレット）', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test('境目を出さず、覚えた幅は当てる', async ({ page }) => {
    await page.goto(today);
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    await page.evaluate(() => {
      localStorage.removeItem('sg-nav-collapsed');
      localStorage.setItem('sg-nav-width', '300');
    });
    await page.reload();
    await expect(page.locator('.app > .binding')).toBeVisible();
    await expect(page.locator('.nav-resize')).toBeHidden();
    await expect(page.getByRole('separator', { name: 'メニューの幅' })).toHaveCount(0);
    await expect(page.locator('.app > .binding')).toHaveJSProperty('offsetWidth', 300);
  });
});

for (const theme of A11Y_THEMES) {
  for (const width of [1280, 800]) {
    test(`境目と札の axe: ${theme}・${width}px`, async ({ page }) => {
      await openFresh(page, width);
      await applyTheme(page, theme);
      await focusByTab(page, separator(page));
      await expect(separator(page).locator('.nav-resize-tip')).toBeVisible();
      await waitForSettled(page);
      expect(await findA11yViolations(page, '.app > .binding')).toEqual([]);
    });
  }
}
