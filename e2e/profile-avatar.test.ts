// #1265: プロフィール画像を API から上げ、組織の管理の「ユーザー」の一覧に画像が出て、外すと前の URL が 404 になるまでを、
// 本番と同じ配り方（CSP の img-src、キャッシュのヘッダー）で通す。上げる画面はまだ無い（次のタスク）。
// 画像は組織ごとなので、並べて走るほかのテストが見ないひばり工房のリン（seed の otherOrg）で上げ、テストの終わりに外して戻す。
// ほかのファイルの e2e にひばり工房の一覧を開いて画像の読み込みを見るものは無い（リンの名前を見るのは organizations.test.ts の上の欄だけ）
import { meAvatarDelete, meAvatarUpload } from '../src/shared/operations/organization/me-avatar.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

// 1px の PNG（e2e/members.test.ts と同じ）
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('上げた画像が管理のユーザー一覧に出て、外すと前の URL は 404 になる', async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const origin = new URL(baseURL).origin;
  await signIn(context, baseURL, 'otherOrg');

  let avatarUrl: string | undefined;
  let removedStatus: number | undefined;
  try {
    const uploaded = await page.request.post(`/api/hibari/${meAvatarUpload.name}`, {
      headers: {
        Origin: origin,
        'X-Operation-Input': encodeURIComponent(JSON.stringify({})),
        'Content-Type': 'image/png',
      },
      data: PIXEL,
    });
    expect(uploaded.status()).toBe(200);
    avatarUrl = meAvatarUpload.output.parse(await uploaded.json()).avatar_url;
    expect(avatarUrl).toMatch(/^\/api\/hibari\/user-avatar\/[0-9a-f-]{36}$/);

    // 配る応答は 200 だけ長めにキャッシュし、添付と同じ sandbox の CSP と nosniff を付ける
    const served = await page.request.get(avatarUrl);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toBe('image/png');
    expect(served.headers()['cache-control']).toBe('private, max-age=3600');
    expect(served.headers()['x-content-type-options']).toBe('nosniff');
    expect(served.headers()['content-security-policy']).toContain('sandbox');
    expect(await served.body()).toEqual(PIXEL);

    // 管理のユーザー一覧のリンの行に、その画像が読み込まれて出る（画面の CSP で読み込めることも確かめる）
    await page.goto('/hibari/admin');
    const row = page
      .getByRole('region', { name: 'ユーザー', exact: true })
      .getByRole('table', { name: '組織のユーザーの一覧' })
      .locator('tbody tr', { hasText: 'リン' });
    const image = row.locator('.avatar img');
    await expect(image).toHaveAttribute('src', avatarUrl);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  } finally {
    // 途中で落ちても、上げたかもしれない画像を外して戻す（画像が無くても 200）。ここでは断言せず、元の失敗を隠さない
    const removed = await page.request.post(`/api/hibari/${meAvatarDelete.name}`, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: {},
    });
    removedStatus = removed.status();
  }
  expect(removedStatus).toBe(200);

  // 外した後の前の URL は 404 で、キャッシュさせない
  if (avatarUrl === undefined) throw new Error('上げた画像の URL が無い');
  const gone = await page.request.get(avatarUrl);
  expect(gone.status()).toBe(404);
  expect(gone.headers()['cache-control']).toBe('private, no-store');
});
