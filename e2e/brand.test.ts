import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

const themes = ['simple_light', 'simple_dark', 'medieval', 'modern'];

async function expectHorizontalBrand(page: Page): Promise<void> {
  const art = page.locator('.brand-art');
  const name = art.locator('.brand-name');
  const logo = art.locator('.brand-mark');
  await expect(art).toHaveCount(1);
  await expect(art).toHaveAttribute('aria-hidden', 'true');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('alt', '');
  await expect(name).toHaveText('スクラムギルド');
  await expect(name).toBeVisible();
  expect(await name.evaluate((el) => el.tagName)).toBe('SPAN');
  await expect(art).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect.poll(() => logo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect
    .poll(() => logo.evaluate((img) => (img as HTMLImageElement).currentSrc))
    .toMatch(/\/brand\/master\/symbol\.png$/);
  const box = (await logo.boundingBox())!;
  expect(box.width).toBeGreaterThan(20);
  expect(Math.abs(box.width / box.height - 629 / 678)).toBeLessThan(0.02);
  const parent = (await art.locator('..').boundingBox())!;
  const placement = await art.evaluate((el) =>
    el.closest('.gate-sheet') ? 'sheet' : el.parentElement?.classList.contains('gate-brand') ? 'header' : 'other',
  );
  if (placement === 'sheet') {
    // 枠の外の紙の中では、白い下地の箱の左端を本文にそろえ、地が白いテーマでも箱が分かるよう内側に細い枠を引く
    const artBox = (await art.boundingBox())!;
    expect(Math.abs(artBox.x - parent.x)).toBeLessThan(1);
    const frame = await art.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-line)';
      el.append(probe);
      const line = getComputedStyle(probe).color;
      probe.remove();
      return { shadow: getComputedStyle(el).boxShadow, line };
    });
    expect(frame.shadow).toContain(frame.line);
    expect(frame.shadow).toMatch(/0px 0px 0px 1px inset/);
  } else if (placement === 'header') {
    const artBox = (await art.boundingBox())!;
    expect(Math.abs(artBox.x - parent.x)).toBeLessThan(1);
  } else {
    expect(box.x).toBeGreaterThanOrEqual(parent.x);
  }
  expect(box.x + box.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const nameBox = (await name.boundingBox())!;
  expect(nameBox.x).toBeGreaterThanOrEqual(box.x + box.width);
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
  // ブランド内の文字は読ませず、サービス名を1回だけ残す
  await expect(art.locator('..').getByText('Scrum Guild', { exact: true })).toHaveCount(1);
}

// 組織の枠の左上の角のマスは、横組みではなくマーク単体を白い枠の中に出し、角のマスの高さに収める
async function expectCornerSymbol(page: Page): Promise<void> {
  const brand = page.locator('.binding-head .brand');
  const art = brand.locator('.brand-art');
  const symbol = art.locator('.brand-mark');
  await expect(art).toHaveAttribute('aria-hidden', 'true');
  await expect(art).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(brand.locator('.brand-name')).toHaveCount(0);
  await expect(symbol).toBeVisible();
  await expect(symbol).toHaveAttribute('alt', '');
  await expect.poll(() => symbol.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(629);
  const box = (await symbol.boundingBox())!;
  const head = (await page.locator('.binding-head').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(head.x);
  expect(box.y).toBeGreaterThanOrEqual(head.y);
  expect(box.y + box.height).toBeLessThanOrEqual(head.y + head.height);
  await expect(brand).toHaveAccessibleName('Scrum Guild');
}

for (const screen of [
  { path: '/login', who: null },
  { path: '/', who: 'admin' },
  { path: '/aoba/w/019a0000-0000-7000-8000-000000000401', who: 'member' },
  { path: '/operator', who: 'operator' },
] as const) {
  test(`${screen.path} のロゴが全テーマと狭い幅で提供素材になり、切れずに収まる`, async ({
    page,
    context,
    baseURL,
  }) => {
    if (screen.who) await signIn(context, baseURL, screen.who);
    await page.goto(screen.path);
    await expect(page).toHaveURL(new URL(screen.path, baseURL).href);
    await expect(page.locator('.brand-art').first()).toBeVisible();
    for (const width of [320, 390, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of themes) {
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        if (screen.path.startsWith('/aoba') && width <= 760) {
          // 角のマスは出さない。残るマークは浮きメニューの中の組織の切り替えのもので、見えない
          await expect(page.locator('.binding-head')).toHaveCount(0);
          await expect(page.locator('.brand-art')).toHaveCount(1);
          await expect(page.locator('.brand-art')).toBeHidden();
          await expect(page.locator('.mobile-tabs')).toBeVisible();
        } else if (screen.path.startsWith('/aoba')) {
          await expectCornerSymbol(page);
        } else {
          await expectHorizontalBrand(page);
        }
      }
    }
  });
}

test('畳んだメニューの角のマスは組織のボタンのマークだけを出し、狭い幅ではロゴを隠す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/aoba');
  const brand = page.getByRole('link', { name: 'Scrum Guild', exact: true });
  await expect(brand).toHaveAttribute('href', '/aoba');
  await expectCornerSymbol(page);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  const org = page.locator('.binding-head .org-menu-button');
  for (const theme of themes) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    // マークのリンクは隠し、組織のボタンの中のマークを見せる（押すと組織の一覧）
    await expect(brand).toBeHidden();
    const symbol = org.locator('.brand-mark');
    await expect(symbol).toBeVisible();
    await expect(org.locator('.brand-art')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect.poll(() => symbol.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(629);
    const box = (await symbol.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(64);
    await expect(org).toHaveAccessibleName('あおば開発。組織を切り替える');
  }
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(brand).toHaveCount(0);
  await expect(page.locator('.mobile-tabs')).toBeVisible();
});

test('faviconとホーム画面アイコンがHTMLではなく画像として配信される', async ({ page, request }) => {
  await page.goto('/login');
  const paths = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestResponse = await request.get(manifestUrl!);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  for (const path of [...paths, ...manifest.icons.map((icon: { src: string }) => icon.src)]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toMatch(/^image\//);
    expect((await response.body()).length).toBeGreaterThan(100);
  }
});
