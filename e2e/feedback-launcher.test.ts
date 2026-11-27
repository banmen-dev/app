// 右下のフィードバックの入口とダイアログ（#1554）。GitHub への起票は feedback-submit の応答を差し替えて確かめる
// （本物の送信は e2e/feedback-submit.test.ts が、GitHub App の無い環境で 503 になることを確かめる）
import type { Locator, Page } from '@playwright/test';
import { feedbackSubmit } from '../src/shared/operations/feedback.ts';
import { expect, test } from './fixtures.ts';
import { expectModalFocus, NARROW_VIEWPORT, signIn } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

const FEEDBACK_ID = '019a0000-0000-7000-8000-00000000fb01';

const launcher = (page: Page) => page.getByRole('button', { name: 'フィードバックを送る' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'フィードバックを送る' });
const field = (page: Page) => dialog(page).getByRole('textbox', { name: '気づいたこと、困ったこと、不具合' });

// 2つの箱が重なるか（1px の接しは重ならないものとする）
async function overlaps(a: Locator, b: Locator): Promise<boolean> {
  const [x, y] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (x === null || y === null) throw new Error('箱が無い');
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
}

test.describe('ログインした画面', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('組織の画面の右下に出て、スクロールしても位置が変わらない', async ({ page }) => {
    await page.goto('/aoba');
    const button = launcher(page);
    await expect(button).toBeVisible();
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('画面の大きさが無い');
    const before = await button.boundingBox();
    if (before === null) throw new Error('ボタンの箱が無い');
    // 右下の隅に置く（右端と下端から 64px の中に収まる）
    expect(viewport.width - (before.x + before.width)).toBeLessThan(64);
    expect(viewport.height - (before.y + before.height)).toBeLessThan(64);
    // seed の画面は画面に収まるので、文書を伸ばしてから末尾まで送る（e2e/shell.test.ts の版と同じ）
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '3000px';
      document.body.append(spacer);
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await button.boundingBox()).toEqual(before);
    // 版の表示と重ならない
    expect(await overlaps(button, page.locator('.app-version'))).toBe(false);
  });

  test('キーボードだけで開き、書いて送ると閉じ、送れたことを知らせる', async ({ page }) => {
    const sent: unknown[] = [];
    await routeOperation(page, feedbackSubmit, async (call) => {
      sent.push(call.input);
      await call.fulfill({ feedback_id: FEEDBACK_ID });
    });
    await page.goto('/aoba?from=e2e#top');
    await launcher(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('公開の GitHub');
    await expect(field(page)).toBeFocused();
    await page.keyboard.type('一覧の見出しが読みにくいです');
    // 欄から、やめる、送るの順に進む
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: '送る' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'フィードバックを送りました' })).toBeVisible();
    expect(sent).toHaveLength(1);
    const origin = new URL(page.url()).origin;
    // URL はクエリとフラグメントを除き、経路は slug を含まない route ID
    expect(sent[0]).toEqual({ text: '一覧の見出しが読みにくいです', route_id: '/[slug]', url: `${origin}/aoba` });
    await expect(launcher(page)).toBeFocused();

    // 開き直すと、入力は空になっている
    await launcher(page).click();
    await expect(field(page)).toHaveValue('');
  });

  test('送れなかったら閉じずに入力を残して理由を出し、Esc で閉じる', async ({ page }) => {
    await failOperation(page, feedbackSubmit, 429, 'rate_limited');
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('送れないはずの文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText(/送る回数の上限に達しました/);
    await expect(dialog(page)).toBeVisible();
    await expect(field(page)).toHaveValue('送れないはずの文');
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(launcher(page)).toBeFocused();
  });

  test('秘密に見える文は理由を出し、空のままでは送らない', async ({ page }) => {
    let calls = 0;
    await routeOperation(page, feedbackSubmit, async (call) => {
      calls += 1;
      await call.fail(400, 'invalid_input', {
        details: [{ path: 'text', code: 'custom', message: 'secret_detected' }],
      });
    });
    await page.goto('/aoba');
    await launcher(page).click();
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText('送る文を入れてください。');
    expect(calls).toBe(0);
    await field(page).fill('ghp_0123456789abcdef');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText(/トークンや秘密鍵のような文字列/);
    expect(calls).toBe(1);
  });

  test('開くと中にフォーカスが入り、Esc で閉じて入口へ戻る', async ({ page }) => {
    await page.goto('/aoba');
    await expectModalFocus(page, { opener: launcher(page), modal: dialog(page) });
  });

  test('組織の選択の画面にも出す', async ({ page }) => {
    await mockOperation(page, feedbackSubmit, { feedback_id: FEEDBACK_ID });
    await page.goto('/');
    await expect(launcher(page)).toBeVisible();
    await launcher(page).click();
    await expect(dialog(page)).toBeVisible();
  });

  test('狭い幅では下のタブと重ならず、送れた知らせはボタンの上に出る', async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await mockOperation(page, feedbackSubmit, { feedback_id: FEEDBACK_ID });
    await page.goto('/aoba');
    const button = launcher(page);
    await expect(button).toBeVisible();
    const tabs = page.locator('.mobile-navigation');
    await expect(tabs).toBeVisible();
    expect(await overlaps(button, page.locator('.mobile-tabs').first())).toBe(false);
    expect(await overlaps(button, page.locator('.app-version'))).toBe(false);
    await button.click();
    await field(page).fill('狭い幅から送ります');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    const toast = page.locator('.toasts .toast').filter({ hasText: 'フィードバックを送りました', visible: true });
    await expect(toast).toBeVisible();
    expect(await overlaps(button, toast)).toBe(false);
  });
});

test('ログインしていない画面には出さない', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(launcher(page)).toHaveCount(0);
});
