import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, signIn } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('組織ホームの今日の行は1280pxでも横に並び、390pxでは折り返す（#1372）', async ({ page }) => {
  await page.goto('/aoba');
  const row = page.locator('.book .entry').first();
  await expect(row).toBeVisible();
  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    for (const width of [1440, 1280, 900, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const main = await row.locator('.entry-main').boundingBox();
      const end = await row.locator('.entry-end').boundingBox();
      expect(main).not.toBeNull();
      expect(end).not.toBeNull();
      if (width >= 1280) {
        if (width === 1280) {
          const minimum = await page.evaluate(
            () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 12,
          );
          expect(main!.width, `${theme}/${width}: 題の幅`).toBeGreaterThanOrEqual(minimum);
        }
        expect(end!.x, `${theme}/${width}: 操作が題の右に並ぶ`).toBeGreaterThanOrEqual(main!.x + main!.width);
        expect(end!.y).toBeLessThan(main!.y + main!.height);
      } else {
        expect(end!.y, `${theme}/${width}: 操作が題の下へ折り返す`).toBeGreaterThanOrEqual(main!.y + main!.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test('組織ホームの台帳は、題と期日の印を読める幅で横に並べる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/aoba');
  const title = page.getByRole('link', { name: '障害時の連絡手順を書く', exact: true });
  const list = page.locator('.book.is-compact').filter({ has: title });
  const row = list.locator('.entry').filter({ has: title });
  const endColumn = row.locator('.entry-end');
  // seed の実際の行。組織ホームは編集用のチップではなく、期日の印、ポイント、担当、完了の操作を出す。
  const due = endColumn.locator('.chip.is-danger');
  await expect(due).toHaveText(/^期日切れ /);
  await expect(endColumn.locator('.pts')).toBeVisible();
  await expect(endColumn.locator('.avatar')).toBeVisible();
  await expect(endColumn.locator('.done-btn')).toBeVisible();
  for (const { zoom, widths, firstInline } of [
    { zoom: 100, widths: [440, 441, 520, 521], firstInline: 441 },
    { zoom: 200, widths: [504, 521, 553, 703, 704, 705], firstInline: 704 },
  ]) {
    await page.evaluate((percent) => {
      document.documentElement.style.fontSize = `${percent}%`;
    }, zoom);
    const minimum = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize) * 12);
    for (const width of widths) {
      await list.evaluate((el, width) => {
        el.style.boxSizing = 'content-box';
        el.style.width = `${width}px`;
      }, width);
      const main = await row.locator('.entry-main').boundingBox();
      const end = await endColumn.boundingBox();
      expect(main).not.toBeNull();
      expect(end).not.toBeNull();
      const label = `文字${zoom}%・台帳${width}px`;
      if (width < firstInline) {
        expect(end!.y, label).toBeGreaterThanOrEqual(main!.y + main!.height);
      } else {
        expect(main!.width, label).toBeGreaterThanOrEqual(minimum);
        expect(end!.x, label).toBeGreaterThanOrEqual(main!.x + main!.width);
        expect(end!.y, label).toBeLessThan(main!.y + main!.height);
        await expect(endColumn).toHaveCSS('flex-wrap', 'wrap');
      }
      const bounds = await row.evaluate((el) => {
        const book = el.closest('.book')!;
        const right = book.getBoundingClientRect().right - parseFloat(getComputedStyle(book).borderRightWidth);
        const column = el.querySelector('.entry-end')!.getBoundingClientRect();
        const items = [...el.querySelectorAll('.entry-chips > *, .entry-actions > *')].map((item) =>
          item.getBoundingClientRect(),
        );
        return {
          right,
          columnRight: column.right,
          itemsFit: items.every((item) => item.left >= column.left && item.right <= column.right),
        };
      });
      expect(bounds.columnRight, label).toBeLessThanOrEqual(bounds.right);
      expect(bounds.itemsFit, label).toBe(true);
      await expect(due).toHaveCSS('white-space', 'nowrap');
      expect(await due.evaluate((el) => el.scrollWidth <= el.clientWidth), label).toBe(true);
    }
  }
});

test('通常の台帳と木はそれぞれの境界で右端を折り返す', async ({ page }) => {
  for (const [path, selector, boundary] of [
    [`${WORKSPACE}/inbox`, '.book', 520],
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
        // 761px 以上は帯と本文の間にパンくずの帯（.sheet-crumbs）を挟み、その上の余白で16pxを取る（#1509）
        const paddingTop = (selector: string) =>
          page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
        expect(await paddingTop(width > 760 ? '.sheet-crumbs' : '.content')).toBeGreaterThanOrEqual(16);
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
