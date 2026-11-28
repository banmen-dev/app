import type { Page } from '@playwright/test';
import { meAvatarDelete, meAvatarUpload } from '../src/shared/operations/organization/index.ts';
import { test, expect } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { routeOperation } from './operations.ts';

const section = (page: Page) => page.getByRole('region', { name: 'プロフィール画像', exact: true });
async function photo(page: Page, mimeType = 'image/png', color = '#0b57d0') {
  const bytes = await page.evaluate(
    async ({ mimeType, color }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#eeeeee';
      ctx.fillRect(0, 0, 320, 480);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), mimeType));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { mimeType, color },
  );
  return { name: 'photo.' + mimeType.split('/')[1], mimeType, buffer: Buffer.from(bytes) };
}
async function upload(page: Page, mimeType = 'image/png', color?: string) {
  await section(page)
    .getByLabel('画像を選ぶ', { exact: true })
    .setInputFiles(await photo(page, mimeType, color));
  const dialog = page.getByRole('dialog', { name: 'プロフィール画像を切り抜く' });
  await expect(dialog).toBeVisible();
  const response = page.waitForResponse(
    (response) => response.url().endsWith('/api/aoba/me-avatar-upload') && response.ok(),
  );
  await dialog.getByRole('button', { name: '上げる', exact: true }).click();
  const result = await response;
  expect(result.request().headers()['x-operation-input']).toBe('%7B%7D');
  await expect(dialog).not.toBeVisible();
  return (await result.json()) as { avatar_url: string };
}

test.describe('プロフィール画像', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });
  test.afterEach(async ({ context, baseURL }) => {
    const response = await context.request.post('/api/aoba/me-avatar-delete', {
      data: {},
      headers: { Origin: new URL(baseURL!).origin },
    });
    expect(response.ok()).toBe(true);
  });

  test('PNGを上げ、JPEG・WebPで差し替え、メニューと一覧に出して外す', async ({ page }) => {
    const violations = await watchViolations(page);
    await page.goto('/aoba/me');
    let url = '';
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      const result = await upload(page, mime, mime === 'image/png' ? '#0b57d0' : '#cc5500');
      expect(result.avatar_url).not.toBe(url);
      url = result.avatar_url;
      await expect(section(page).locator('.avatar img')).toHaveAttribute('src', url);
      await expect(page.locator('.account-menu-button .avatar img')).toHaveAttribute('src', url);
    }
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401/members');
    await expect(
      page
        .getByRole('table', { name: '所属している人の一覧' })
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: /ハルカ/ }) })
        .locator(`.avatar img[src="${url}"]`),
    ).toBeVisible();
    await page.goto('/aoba/me');
    await section(page).getByRole('button', { name: '外す', exact: true }).click();
    await expect(section(page).getByRole('button', { name: '外す', exact: true })).toHaveCount(0);
    await expect(section(page).locator(`img[src="${url}"]`)).toHaveCount(0);
    await expect(page.locator(`.account-menu-button img[src="${url}"]`)).toHaveCount(0);
    expect((await page.request.get(url)).status()).toBe(404);
    expect(await violations()).toEqual([]);
  });

  test('390pxで範囲をドラッグ・矢印キー・移動ボタン・拡大率で変え、やめると送らない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/aoba/me');
    await expect(section(page).getByRole('button', { name: '画像を選ぶ', exact: true })).toHaveCount(1);
    let uploads = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/me-avatar-upload')) uploads++;
    });
    await section(page)
      .getByLabel('画像を選ぶ', { exact: true })
      .setInputFiles(await photo(page));
    const dialog = page.getByRole('dialog', { name: 'プロフィール画像を切り抜く' });
    const range = dialog.getByRole('slider', { name: '拡大率' });
    await range.focus();
    await range.press('Home');
    for (let i = 0; i < 20; i++) await range.press('ArrowRight');
    await expect(range).toHaveValue('2');
    const position = dialog.getByRole('status').filter({ hasText: /^中心の位置:/ });
    await expect(position).toHaveAttribute('aria-live', 'polite');
    const preview = dialog.getByRole('img', { name: '切り抜きの範囲', exact: true });
    const moveLeft = dialog.getByRole('button', { name: '範囲を左へ', exact: true });
    await moveLeft.focus();
    await moveLeft.press('ArrowRight');
    await expect(position).toHaveText('中心の位置: 横 51%、縦 50%');
    const moveRight = dialog.getByRole('button', { name: '範囲を右へ', exact: true });
    await moveRight.focus();
    await moveRight.press('Enter');
    await expect(position).toHaveText('中心の位置: 横 55%、縦 50%');
    await moveRight.press('Space');
    await expect(position).toHaveText('中心の位置: 横 58%、縦 50%');
    await dialog.getByRole('button', { name: '範囲を下へ', exact: true }).click();
    await expect(position).toHaveText('中心の位置: 横 58%、縦 55%');
    const beforeDrag = await position.textContent();
    await expect(preview).toHaveCSS('touch-action', 'none');
    const bounds = await preview.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(256);
    expect(Math.abs(bounds!.width - bounds!.height)).toBeLessThan(1);
    await page.mouse.move(bounds!.x + 100, bounds!.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + 120, bounds!.y + 110);
    await page.mouse.up();
    const horizontalCenter = (text: string) => Number(text.match(/横 (\d+)%/)![1]);
    await expect
      .poll(async () => horizontalCenter((await position.textContent())!))
      .toBeLessThan(horizontalCenter(beforeDrag!));
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
    expect(uploads).toBe(0);
    await expect(section(page).getByRole('button', { name: '画像を選ぶ', exact: true })).toBeFocused();
  });

  test('透過PNGを拡大したとき前の範囲の画素を残さない', async ({ page }) => {
    await page.goto('/aoba/me');
    const buffer = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#0b57d0';
      context.fillRect(0, 0, 160, 480);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await section(page)
      .getByLabel('画像を選ぶ', { exact: true })
      .setInputFiles({ name: 'transparent.png', mimeType: 'image/png', buffer: Buffer.from(buffer) });
    const dialog = page.getByRole('dialog', { name: 'プロフィール画像を切り抜く' });
    const canvas = dialog.locator('canvas');
    await expect
      .poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[3]))
      .toBe(255);
    const range = dialog.getByRole('slider', { name: '拡大率' });
    await range.focus();
    await range.press('End');
    await expect
      .poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[3]))
      .toBe(0);
    await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
  });

  test('合わない種類と壊れた画像を送らず、400の理由を出して再試行できる', async ({ page }) => {
    await page.goto('/aoba/me');
    for (const [name, mimeType, data] of [
      ['a.svg', 'image/svg+xml', '<svg/>'],
      ['a.gif', 'image/gif', 'GIF89a'],
      ['a.txt', 'text/plain', 'text'],
    ]) {
      await section(page)
        .getByLabel('画像を選ぶ', { exact: true })
        .setInputFiles({ name, mimeType, buffer: Buffer.from(data) });
      await expect(section(page).getByRole('alert')).toContainText('PNG、JPEG、WebP');
      await expect(page.getByRole('dialog')).not.toBeVisible();
    }
    await section(page)
      .getByLabel('画像を選ぶ', { exact: true })
      .setInputFiles({
        name: 'broken.png',
        mimeType: 'image/png',
        buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      });
    await expect(section(page).getByRole('alert')).toContainText('画像を読み込めませんでした');
    await section(page)
      .getByLabel('画像を選ぶ', { exact: true })
      .setInputFiles(await photo(page));
    const dialog = page.getByRole('dialog', { name: 'プロフィール画像を切り抜く' });
    for (const status of [400, 413]) {
      let releaseResponse!: () => void;
      const held = new Promise<void>((resolve) => (releaseResponse = resolve));
      // 1回だけ断る。2回目からは本物の API へ流す
      let refused = false;
      const unrouteUpload = await routeOperation(page, meAvatarUpload, { slug: 'aoba' }, async (call) => {
        if (refused) return call.passThrough();
        refused = true;
        await held;
        return call.fail(status, 'invalid_input');
      });
      const rejected = page.waitForResponse(
        (response) => response.url().endsWith('/api/aoba/me-avatar-upload') && response.status() === status,
      );
      await dialog.getByRole('button', { name: '上げる', exact: true }).click();
      try {
        await expect(dialog.getByRole('alert')).toBeEmpty();
      } finally {
        releaseResponse();
      }
      await rejected;
      await expect(dialog.getByRole('alert')).toContainText('512KiB');
      await unrouteUpload();
    }
    await dialog.getByRole('button', { name: '上げる', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(section(page).getByRole('button', { name: '外す', exact: true })).toBeVisible();
    // 1回だけ失敗させる。2回目からは本物の API へ流す
    let failed = false;
    await routeOperation(page, meAvatarDelete, { slug: 'aoba' }, (call) => {
      if (failed) return call.passThrough();
      failed = true;
      return call.fail(500, 'internal');
    });
    await section(page).getByRole('button', { name: '外す', exact: true }).click();
    await expect(section(page).getByRole('alert')).toContainText('プロフィール画像を変更できませんでした');
    await expect(section(page).locator('.avatar img')).toBeVisible();
    await section(page).getByRole('button', { name: '外す', exact: true }).click();
    await expect(section(page).getByRole('button', { name: '外す', exact: true })).toHaveCount(0);
  });
});
