import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, signIn } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('今日の行は広い幅で横に並び、390pxでは折り返す（#1003）', async ({ page }) => {
  await page.goto('/aoba');
  const row = page.locator('.book .entry').first();
  await expect(row).toBeVisible();
  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    for (const width of [1440, 1280, 900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const main = await row.locator('.entry-main').boundingBox();
      const end = await row.locator('.entry-end').boundingBox();
      expect(main).not.toBeNull();
      expect(end).not.toBeNull();
      // 今日の行は、組織のホームの左の列（ダッシュボードの左3、右2の左。面の内側は --space-6）に入る。右の列の幅を空けるので、
      // メニューを開いた状態では、幅が約 1284px を下回ると台帳の内側が折り返しの境（520px）を下回り、操作が題の下へ折り返す。
      // 1280px（PC の代表幅）の折り返しは、人が見本で判断する前の今の状態を固定する期待で、直すと決めたらこの期待を変える。
      // 境に近い幅（1300px など）の余裕は、余白の段や字形で数 px 動くので確かめない（脆いテストになる）。
      // 横並びの確かめは、余裕のある 1440px（台帳 612px）で行う
      if (width >= 1440) {
        expect(end!.x, `${theme}/${width}: 操作が題の右に並ぶ`).toBeGreaterThanOrEqual(main!.x + main!.width);
        expect(end!.y).toBeLessThan(main!.y + main!.height);
      } else {
        expect(end!.y, `${theme}/${width}: 操作が題の下へ折り返す`).toBeGreaterThanOrEqual(main!.y + main!.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test('台帳は520px、木は640pxを境にタスクの右端を折り返す（#1003）', async ({ page }) => {
  for (const [path, selector, boundary] of [
    ['/aoba', '.book', 520],
    [WORKSPACE, '.tree', 640],
  ] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(path);
    const list = page.locator(selector).first();
    const row = list.locator('.entry').first();
    await expect(row).toBeVisible();
    for (const width of [boundary, boundary + 1]) {
      // 枠線を含まないコンテナの幅を境界ぴったりにする。
      await list.evaluate((el, width) => {
        el.style.boxSizing = 'content-box';
        el.style.width = `${width}px`;
      }, width);
      const main = await row.locator('.entry-main').boundingBox();
      const end = await row.locator('.entry-end').boundingBox();
      expect(main).not.toBeNull();
      expect(end).not.toBeNull();
      expect(end!.y >= main!.y + main!.height).toBe(width === boundary);
    }
  }
});

for (const path of ['/aoba', '/aoba/me', '/aoba/wiki']) {
  test(`${path} の見出しは帯から16px以上離れる（#1003）`, async ({ page }) => {
    await page.goto(path);
    const heading = page.locator('.content').getByRole('heading').first();
    await expect(heading).toBeVisible();
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        // 日付や見出し自身の余白で偶然16pxを超えても、本文の余白の回帰を見逃さない。
        expect(
          await page.locator('.content').evaluate((el) => parseFloat(getComputedStyle(el).paddingTop)),
        ).toBeGreaterThanOrEqual(16);
        const title = await heading.boundingBox();
        expect(title).not.toBeNull();
        if (width > 760) {
          const band = await page.locator('.topbar').boundingBox();
          expect(band).not.toBeNull();
          expect(title!.y - band!.y - band!.height).toBeGreaterThanOrEqual(16);
        } else {
          await expect(page.locator('.topbar')).toHaveCount(0);
          const content = await page.locator('.content').boundingBox();
          expect(content).not.toBeNull();
          expect(title!.y - content!.y).toBeGreaterThanOrEqual(16);
        }
      }
    }
  });
}

test.describe('指で押す画面の台帳', () => {
  test.use({ hasTouch: true, viewport: { width: 1280, height: 900 } });

  for (const [path, selector, boundary, widths] of [
    ['/aoba', '.book', 520, [400, 520, 521, 594, 640]],
    [WORKSPACE, '.tree', 640, [640, 641]],
  ] as const) {
    test(`${selector} は境界以下で折り返し、横並びでは題の12remを保つ`, async ({ page }) => {
      await page.goto(path);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      const list = page.locator(selector).first();
      const row = list.locator('.entry').first();
      await expect(row).toBeVisible();
      // 文字を大きくした端末でも、44pxの操作が題を押しのけない。
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '150%';
      });
      for (const theme of A11Y_THEMES) {
        await applyTheme(page, theme);
        const minimum = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize) * 12);
        for (const width of widths) {
          await list.evaluate((el, width) => {
            el.style.boxSizing = 'content-box';
            el.style.width = `${width}px`;
          }, width);
          const main = await row.locator('.entry-main').boundingBox();
          const end = await row.locator('.entry-end').boundingBox();
          expect(main).not.toBeNull();
          expect(end).not.toBeNull();
          if (width <= boundary) {
            expect(end!.y, `${theme}/${width}: 右端が題の下へ移る`).toBeGreaterThanOrEqual(main!.y + main!.height);
          } else {
            expect(main!.width, `${theme}/${width}: 題の幅`).toBeGreaterThanOrEqual(minimum);
            expect(end!.x).toBeGreaterThanOrEqual(main!.x + main!.width);
          }
          await expect(row.locator('.entry-end')).toHaveCSS('flex-wrap', 'wrap');
        }
      }
    });
  }
});
