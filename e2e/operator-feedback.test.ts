// フィードバックの閲覧の画面（/operator/feedback/[id]。Issue #1557）。
// e2e の Worker には運用者の一覧（シークレット OPERATOR_LOGIN_IDS）も R2 のフィードバックも無いので、運用者の操作の応答は差し替える。
// サーバーの処理（運用者でない人の 403、存在しない ID の 404、画像の配り方）は test/operator-feedback.test.ts、
// ログインしていない人のログインへの移しと、運用者でない人の戻しは本物のサーバーで確かめる
import type { OutputOf } from '../src/shared/operations/define.ts';
import { feedbackImageRef, listOrganizations, operatorFeedback } from '../src/shared/operations/operator/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled } from './helpers.ts';
import { failOperation, mockOperation } from './operations.ts';

const FEEDBACK_ID = '01939c12-0000-7000-8000-000000000001';
const IMAGE_ID = '01939c12-0000-7000-8000-000000000002';
const PATH = `/operator/feedback/${FEEDBACK_ID}`;

const feedback: OutputOf<typeof operatorFeedback> = {
  feedback_id: FEEDBACK_ID,
  account_id: '01939c12-0000-7000-8000-0000000000aa',
  url: 'https://banmen.example/aoba/w/ws/board',
  route_id: '/[slug]/w/[id]/board',
  text: '見出しが切れています\n<b>太字ではない</b> @someone',
  images: [{ id: IMAGE_ID, content_type: 'image/png', bytes: 2048 }],
  submitted_at: '2026-11-24T07:00:00.000Z',
};

test('ログインしていない人がリンクを開くと、ログインの画面に移り、ログインの後にこのページへ戻る', async ({ page }) => {
  await page.goto(PATH);
  await expect(page).toHaveURL(new RegExp(`/login\\?return_to=${encodeURIComponent(PATH).replaceAll('.', '\\.')}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  // 移り続けず、ログインの後の戻り先が開始の URL に渡る
  await expect(page.getByRole('link', { name: 'GitHub でログイン' })).toHaveAttribute(
    'href',
    `/api/auth/github/start?return_to=${encodeURIComponent(PATH)}`,
  );
});

test('運用者でない人が開くと、ダッシュボードに戻る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'lookMember');
  await page.goto(PATH);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
});

test.describe('運用者', () => {
  test.use({ timezoneId: 'Asia/Tokyo' });

  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'operator');
  });

  test('文、URL、アカウントの ID を文字のまま出し、画像はダウンロードの操作にする', async ({ page }) => {
    await mockOperation(page, operatorFeedback, feedback);
    await page.goto(PATH);
    await waitForSettled(page);
    await expect(page.getByRole('heading', { level: 1, name: 'フィードバック' })).toBeVisible();
    const main = page.locator('.gate-sheet');
    await expect(main).toContainText('https://banmen.example/aoba/w/ws/board');
    await expect(main).toContainText('/[slug]/w/[id]/board');
    await expect(main).toContainText(feedback.account_id);
    await expect(main).toContainText('2026/11/24');
    // 利用者の文は HTML としてもリンクとしても解釈しない
    const text = main.locator('.doc-box.is-plain');
    await expect(text).toHaveText(feedback.text);
    await expect(text.locator('b, a')).toHaveCount(0);
    // 画像は同じオリジンで描かず、ダウンロードのリンクにする
    await expect(main.locator('.form-actions img')).toHaveCount(0);
    const link = main.getByRole('link', { name: /画像 1 をダウンロード/ });
    await expect(link).toHaveAttribute(
      'href',
      `/api/operator-feedback-image/${feedbackImageRef(FEEDBACK_ID, IMAGE_ID)}`,
    );
    await expect(link).toHaveAttribute('download', '');
  });

  test('招待と認証の画面から送られたもの（URL なし、画像なし）も出せる', async ({ page }) => {
    await mockOperation(page, operatorFeedback, { ...feedback, url: null, route_id: null, images: [] });
    await page.goto(PATH);
    await waitForSettled(page);
    const main = page.locator('.gate-sheet');
    await expect(main).toContainText('残していません');
    await expect(main).toContainText('画像は添えられていません');
    await expect(main.getByRole('link', { name: /ダウンロード/ })).toHaveCount(0);
  });

  for (const [label, status, code] of [
    ['存在しない、または消えた', 404, 'not_found'],
    ['長すぎる', 400, 'invalid_input'],
  ] as const) {
    test(`${label} ID は見つからないと出し、運用の画面へ戻れる`, async ({ page }) => {
      await failOperation(page, operatorFeedback, status, code);
      await mockOperation(page, listOrganizations, { organizations: [] });
      await page.goto(PATH);
      await waitForSettled(page);
      await expect(page.getByText('フィードバックが見つかりません')).toBeVisible();
      await page.getByRole('link', { name: '運用の画面へ' }).click();
      await expect(page).toHaveURL(/\/operator$/);
    });
  }
});
