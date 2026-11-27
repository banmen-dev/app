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
    // 閉じている間は中身を描かないので、囲みは開いたダイアログの中にだけある
    await expect(page.locator('.callout')).toHaveCount(1);
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

  test('送っている間は二重に送らず欄を読むだけにし、閉じる操作は止めない。閉じた後に送れたら知らせる', async ({
    page,
  }) => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, feedbackSubmit, async (call) => {
      calls += 1;
      await held;
      await call.fulfill({ feedback_id: FEEDBACK_ID });
    });
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('送っている途中で閉じる文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    const sendingButton = dialog(page).getByRole('button', { name: '送っています…' });
    await expect(sendingButton).toHaveAttribute('aria-disabled', 'true');
    await expect(field(page)).toHaveAttribute('readonly', '');
    // 送っている間にもう一度押しても、送るのは1回
    // aria-disabled のボタンは Playwright が押せないものとして待つので、力ずくで押す
    await sendingButton.click({ force: true });
    await sendingButton.press('Enter');
    expect(calls).toBe(1);
    // 通信が詰まっても出られるよう、Esc で閉じられる
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    // 開き直しても、送り終わるまでは送れない
    await launcher(page).click();
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    release();
    await expect(page.getByRole('status').filter({ hasText: 'フィードバックを送りました' })).toBeVisible();
    expect(calls).toBe(1);
    await launcher(page).click();
    await expect(field(page)).toHaveValue('');
  });

  test('閉じた後に送れなかったら、理由をトーストで出して入力を残す', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, feedbackSubmit, async (call) => {
      await held;
      await call.fail(503, 'unavailable');
    });
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('閉じた後に失敗する文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    release();
    const toast = page.getByRole('status').filter({ hasText: '今はフィードバックを受け付けられませんでした' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('書いた文は残っています');
    // 送り直すと同じ文が2件載りうることを添える
    await expect(toast).toContainText('同じ文が2件になることがあります');
    await launcher(page).click();
    await expect(field(page)).toHaveValue('閉じた後に失敗する文');
  });

  test('送っている間に閉じて別の画面へ移っても、書いた文と送っている途中の印は残り、失敗の案内のとおり開き直せる', async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, feedbackSubmit, async (call) => {
      await held;
      await call.fail(429, 'rate_limited');
    });
    await page.goto('/');
    await launcher(page).click();
    await field(page).fill('組織の選択から書いた文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    // 読み直さずに（SPA の中で）組織の画面へ移る。入口は別の画面の別の部品になる
    await page.locator('a[href="/aoba"]').first().click();
    await expect(page).toHaveURL(/\/aoba$/);
    await launcher(page).click();
    await expect(field(page)).toHaveValue('組織の選択から書いた文');
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    // 開いている間に失敗が届いたら、トーストでなく欄の下に理由を出す
    release();
    await expect(dialog(page).getByRole('alert')).toHaveText(/送る回数の上限に達しました/);
    await expect(field(page)).toHaveValue('組織の選択から書いた文');
    await expect(dialog(page).getByRole('button', { name: '送る' })).toBeVisible();
  });

  test('送り始めた画面から移った後に送れたら、移った先で開いているダイアログを閉じて知らせる', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, feedbackSubmit, async (call) => {
      await held;
      await call.fulfill({ feedback_id: FEEDBACK_ID });
    });
    await page.goto('/');
    await launcher(page).click();
    await field(page).fill('移った先で送れる文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('a[href="/aoba"]').first().click();
    await expect(page).toHaveURL(/\/aoba$/);
    await launcher(page).click();
    await expect(dialog(page)).toBeVisible();
    release();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'フィードバックを送りました' })).toBeVisible();
    await launcher(page).click();
    await expect(field(page)).toHaveValue('');
  });

  test('送り始めた画面から移り、閉じたまま失敗が届いたら、理由をトーストで出し、開き直すと文が残っている', async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, feedbackSubmit, async (call) => {
      await held;
      await call.fail(429, 'rate_limited');
    });
    await page.goto('/');
    await launcher(page).click();
    await field(page).fill('閉じたまま失敗する文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('a[href="/aoba"]').first().click();
    await expect(page).toHaveURL(/\/aoba$/);
    release();
    const toast = page.getByRole('status').filter({ hasText: '送る回数の上限に達しました' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('書いた文は残っています');
    await launcher(page).click();
    await expect(field(page)).toHaveValue('閉じたまま失敗する文');
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  });

  test('応答が 30 秒来なければ送り直せるようにし、同じ文が2件になりうることを出す', async ({ page }) => {
    await page.clock.install();
    let calls = 0;
    const releases: (() => void)[] = [];
    await routeOperation(page, feedbackSubmit, async (call) => {
      calls += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      await call.fulfill({ feedback_id: FEEDBACK_ID });
    });
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('応答が詰まる文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await page.clock.fastForward(30_000);
    await expect(
      dialog(page).locator('.callout.is-warn', { hasText: /応答がありません。送り直せますが/ }),
    ).toBeVisible();
    await expect(field(page)).not.toHaveAttribute('readonly');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect.poll(() => calls).toBe(2);
    // 前の送信が先に送れたら、送り直した方を待たずに閉じて知らせる
    releases[0]!();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'フィードバックを送りました' }).first()).toBeVisible();
    releases[1]!();
    await launcher(page).click();
    await expect(field(page)).toHaveValue('');
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  });

  test('詰まるのは 29 秒より後、30 秒までで、送り直した後に前の送信の失敗が届いても画面は変えず、送り直した方の結果を出す', async ({
    page,
  }) => {
    await page.clock.install();
    const releases: (() => void)[] = [];
    let calls = 0;
    await routeOperation(page, feedbackSubmit, async (call) => {
      const nth = ++calls;
      await new Promise<void>((resolve) => releases.push(resolve));
      if (nth === 1) await call.fail(429, 'rate_limited');
      else await call.fulfill({ feedback_id: FEEDBACK_ID });
    });
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('境目を確かめる文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    // 時計は実時間でも進むので、境目は 1 秒の幅で見る（29 秒では詰まらず、30 秒で詰まる）
    await page.clock.fastForward(29_000);
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await expect(field(page)).toHaveAttribute('readonly', '');
    await expect(dialog(page).locator('.callout.is-warn', { hasText: /応答がありません/ })).toHaveCount(0);
    await page.clock.fastForward(1_000);
    await expect(dialog(page).locator('.callout.is-warn', { hasText: /応答がありません/ })).toBeVisible();
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect.poll(() => calls).toBe(2);
    // 前の送信の失敗は、送り直した方を待っている画面に出さない
    releases[0]!();
    await expect(dialog(page).getByRole('button', { name: '送っています…' })).toBeVisible();
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await expect(field(page)).toHaveValue('境目を確かめる文');
    releases[1]!();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'フィードバックを送りました' })).toBeVisible();
  });

  test('詰まった後に文を直している間に前の送信が送れても、直している文は消さず、ダイアログも閉じない', async ({
    page,
  }) => {
    await page.clock.install();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, feedbackSubmit, async (call) => {
      await held;
      await call.fulfill({ feedback_id: FEEDBACK_ID });
    });
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('最初の文');
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await page.clock.fastForward(30_000);
    await expect(field(page)).not.toHaveAttribute('readonly');
    await field(page).fill('直している文');
    release();
    await expect(page.getByRole('status').filter({ hasText: 'フィードバックを送りました' })).toBeVisible();
    await expect(dialog(page)).toBeVisible();
    await expect(field(page)).toHaveValue('直している文');
    await expect(dialog(page).getByRole('button', { name: '送る' })).toBeVisible();
  });

  test('ログインが切れていたらログインへ、同意していなければ同意の画面へ移す', async ({ page }) => {
    const unroute = await failOperation(page, feedbackSubmit, 401, 'unauthenticated');
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('ログインが切れている');
    const toLogin = page.waitForURL(/\/login\?return_to=%2Faoba$/, { waitUntil: 'commit' });
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await toLogin;
    await unroute();

    await failOperation(page, feedbackSubmit, 403, 'terms_required');
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('同意していない');
    const toConsent = page.waitForURL(/\/consent\?return_to=%2Faoba$/, { waitUntil: 'commit' });
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await toConsent;
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

  test('狭い幅では下のタブと重ならず、送れた知らせはボタンに隠れずに出る', async ({ page }) => {
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
    // トーストはボタンより上に重なる。トーストの中ほどを指すと、トーストの中の要素に当たる
    const box = await toast.boundingBox();
    if (box === null) throw new Error('トーストの箱が無い');
    const hit = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return element !== null && element.closest('.toast') !== null;
      },
      {
        x: box.x + box.width - 12,
        y: box.y + box.height / 2,
      },
    );
    expect(hit).toBe(true);
  });
});

// 1×1 の PNG。画像として読め、縮小の絵に描ける
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') });

// クリップボードの貼り付けと、ファイルのドラッグ＆ドロップを、ブラウザの中で作って欄へ送る
async function pasteImage(page: Page, name: string): Promise<void> {
  await field(page).evaluate(
    (element, { name, data }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    },
    { name, data: PNG_BASE64 },
  );
}

async function dropFile(page: Page, name: string, content: string | null = null): Promise<void> {
  await dialog(page)
    .locator('.dropzone')
    .evaluate(
      (element, { name, data, text }) => {
        const bytes =
          text === null ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(text);
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], name, { type: text === null ? 'image/png' : 'image/svg+xml' }));
        for (const type of ['dragover', 'drop']) {
          element.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
        }
      },
      { name, data: PNG_BASE64, text: content },
    );
}

test.describe('画像を付ける', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('選ぶ、貼る、落とすで付き、縮小の行が出て外せる。上限に達すると付ける欄が止まり、外すと戻る', async ({
    page,
  }) => {
    await page.goto('/aoba');
    await launcher(page).click();
    const rows = dialog(page).locator('.file-row');
    await expect(rows).toHaveCount(0);

    await dialog(page).locator('input[data-feedback-images]').setInputFiles(png('選んだ.png'));
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('選んだ.png');
    await expect(rows.first().locator('canvas.file-preview')).toBeVisible();
    await pasteImage(page, '貼った.png');
    await expect(rows).toHaveCount(2);
    await dropFile(page, '落とした.png');
    await expect(rows).toHaveCount(3);
    // 3枚で付ける欄が止まる
    await expect(dialog(page).locator('.dropzone.is-disabled')).toContainText('3枚まで付いています');
    await expect(dialog(page).getByRole('button', { name: '画像を選ぶ' })).toHaveCount(0);

    await dialog(page).getByRole('button', { name: '貼った.png を外す' }).click();
    await expect(rows).toHaveCount(2);
    await expect(dialog(page).getByRole('button', { name: '画像を選ぶ' })).toBeFocused();
  });

  test('形式の外と大きすぎる画像は付ける前に名前と理由を出し、枚数の外も断る', async ({ page }) => {
    await page.goto('/aoba');
    await launcher(page).click();
    await dropFile(page, '図.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(dialog(page).getByRole('alert').filter({ hasText: '図.svg は付けられませんでした' })).toContainText(
      'PNG、JPEG、WebP の静止画だけ',
    );
    await expect(dialog(page).locator('.file-row')).toHaveCount(0);

    await dialog(page)
      .locator('input[data-feedback-images]')
      .setInputFiles({
        name: '大きい.png',
        mimeType: 'image/png',
        buffer: Buffer.concat([Buffer.from(PNG_BASE64, 'base64'), Buffer.alloc(4 * 1024 * 1024)]),
      });
    await expect(dialog(page).getByRole('alert').filter({ hasText: '大きい.png' })).toContainText('1枚 4 MB まで');

    await dialog(page)
      .locator('input[data-feedback-images]')
      .setInputFiles(['1', '2', '3', '4'].map((n) => png(`${n}.png`)));
    await expect(dialog(page).locator('.file-row')).toHaveCount(3);
    await expect(dialog(page).getByRole('alert').filter({ hasText: '4.png' })).toContainText('3枚まで');
  });

  test('画像を付けて送ると画像が同じリクエストで送られ、送れたら空になる', async ({ page }) => {
    const parts: number[] = [];
    page.on('request', async (request) => {
      if (!request.url().endsWith('/api/feedback-submit')) return;
      const contentType = request.headers()['content-type'] ?? '';
      const form = await new Response(new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0)), {
        headers: { 'Content-Type': contentType },
      }).formData();
      parts.push(form.getAll('file').length);
    });
    await routeOperation(page, feedbackSubmit, (call) => call.fulfill({ feedback_id: FEEDBACK_ID }));
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('画面が崩れます');
    await dialog(page)
      .locator('input[data-feedback-images]')
      .setInputFiles([png('a.png'), png('b.png')]);
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page)).toBeHidden();
    expect(parts).toEqual([2]);
    await launcher(page).click();
    await expect(dialog(page).locator('.file-row')).toHaveCount(0);
    await expect(field(page)).toHaveValue('');
  });

  test('サーバーが画像を断ったら、画像と文を残して理由を出す', async ({ page }) => {
    await failOperation(page, feedbackSubmit, 400, 'invalid_input', {
      details: [{ path: 'files', code: 'custom', message: 'image_unsupported' }],
    });
    await page.goto('/aoba');
    await launcher(page).click();
    await field(page).fill('動く画像です');
    await dialog(page).locator('input[data-feedback-images]').setInputFiles(png('a.png'));
    await dialog(page).getByRole('button', { name: '送る' }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('PNG、JPEG、WebP の静止画だけ');
    await expect(dialog(page).locator('.file-row')).toHaveCount(1);
    await expect(field(page)).toHaveValue('動く画像です');
  });
});

test('ログインしていない画面には出さない', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(launcher(page)).toHaveCount(0);
});

test('運用の画面にも出す', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'operator');
  await page.goto('/operator');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await launcher(page).click();
  await expect(dialog(page)).toBeVisible();
});
