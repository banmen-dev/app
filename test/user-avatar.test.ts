// 組織の人のプロフィール画像を配る操作（user-avatar。Issue #1265）。上げる処理を通さずに行と R2 のファイルを置いて確かめる。
// 完了条件: 同じ組織の人に画像を返し、200 の応答は Cache-Control: private, max-age=3600、404 の応答と添付のダウンロードは今どおり
// private, no-store。別の組織のセッションで開くと 404。
// セッションが置いた前提: 配る応答は nosniff と添付と同じ sandbox の CSP。種類は行の保存値で決める（R2 のメタデータを読まない）
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { userAvatar } from '../src/shared/operations/organization/index.ts';
import { operationMethod, operationPath } from '../src/shared/operations/define.ts';
import { attachmentCacheControl, attachmentCsp } from '../src/shared/security-headers.ts';
import { download, storedFile } from './attachment-download-helpers.ts';
import { jpegImage, webpLossy } from './avatar-images.ts';
import { uuidv7 } from './factories.ts';
import { errorCodeOf } from './operations/harness.ts';
import { avatarUrlOf, expectNotFound, getAvatar, newMember, storeAvatar } from './me-avatar-helpers.ts';
import { createTarget, type Target } from './operations/world.ts';

describe('URL', () => {
  test('GET /api/<slug>/user-avatar/<画像の ID>', () => {
    expect(operationMethod(userAvatar)).toBe('GET');
    expect(operationPath(userAvatar, 'aoba', { id: 'abc' })).toBe('/api/aoba/user-avatar/abc');
  });
});

describe('同じ組織の人に、保存した種類で画像を返す', () => {
  let target: Target;
  let other: Target;
  beforeAll(async () => {
    [target, other] = await Promise.all([createTarget(), createTarget()]);
  });

  test.each([
    ['image/png', undefined],
    ['image/jpeg', () => jpegImage(40, 30)],
    ['image/webp', () => webpLossy(40, 30)],
  ] as const)('%s', async (contentType, make) => {
    const owner = await newMember(target);
    const stored = await storeAvatar(target.organization, owner.userId!, {
      contentType,
      ...(make === undefined ? {} : { bytes: make() }),
    });
    for (const viewer of [target.admin, target.leader, target.member, target.bystander, owner]) {
      const res = await getAvatar(avatarUrlOf(target, stored.id), viewer);
      expect(res.status).toBe(200);
      // R2 のメタデータ（text/html）でなく、行の保存値
      expect(res.headers.get('Content-Type')).toBe(contentType);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(stored.bytes);
    }
  });

  test('200 の応答は private, max-age=3600、nosniff、添付と同じ sandbox の CSP', async () => {
    const stored = await storeAvatar(target.organization, (await newMember(target)).userId!);
    const res = await getAvatar(avatarUrlOf(target, stored.id), target.leader);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(attachmentCsp);
    await res.arrayBuffer();
  });

  test('別の組織のセッションで開くと 404（その組織の slug でも、自分の組織の slug でも）', async () => {
    const stored = await storeAvatar(target.organization, (await newMember(target)).userId!);
    // 別の組織の人は、この組織に入れない
    await expectNotFound(await getAvatar(avatarUrlOf(target, stored.id), other.admin));
    // 別の組織の人が自分の組織の slug で、この組織の画像の ID を開く
    for (const viewer of [other.admin, other.member]) {
      await expectNotFound(await getAvatar(avatarUrlOf(other, stored.id), viewer));
    }
  });

  test('存在しない ID は 404 で、キャッシュに残さない（private, no-store）', async () => {
    const res = await getAvatar(avatarUrlOf(target, uuidv7()), target.member);
    await expectNotFound(res);
    expect(res.headers.get('Content-Security-Policy')).toBe(attachmentCsp);
  });

  test('行があっても R2 のファイルが無ければ 404', async () => {
    const stored = await storeAvatar(target.organization, (await newMember(target)).userId!, { r2: false });
    await expectNotFound(await getAvatar(avatarUrlOf(target, stored.id), target.member));
  });

  test('行の無い R2 のファイル（接頭辞の下に残ったもの）は、キーの末尾の ID でも開けない', async () => {
    const owner = await newMember(target);
    const id = uuidv7();
    await env.ATTACHMENTS.put(`${target.organization.id}/avatars/${owner.userId}/${id}`, jpegImage(8, 8));
    await expectNotFound(await getAvatar(avatarUrlOf(target, id), target.member));
  });

  test('添付の ID を user-avatar で、画像の ID を添付のダウンロードで開いても 404', async () => {
    const { row } = await storedFile(target, { person: target.member });
    await expectNotFound(await getAvatar(avatarUrlOf(target, row.id), target.member));
    const stored = await storeAvatar(target.organization, (await newMember(target)).userId!);
    const res = await download(target, stored.id, { person: target.member });
    expect(res.status).toBe(404);
  });

  test('ログインしていないと 401 で、キャッシュに残さない', async () => {
    const stored = await storeAvatar(target.organization, (await newMember(target)).userId!);
    const res = await getAvatar(avatarUrlOf(target, stored.id), null);
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
    expect(res.headers.get('Cache-Control')).toBe(attachmentCacheControl);
  });

  test('ID が長すぎると 400 の invalid_input', async () => {
    const res = await getAvatar(avatarUrlOf(target, 'a'.repeat(65)), target.member);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('別のサイトからの読み込み（Sec-Fetch-Site: cross-site）は 403', async () => {
    const stored = await storeAvatar(target.organization, (await newMember(target)).userId!);
    const res = await getAvatar(avatarUrlOf(target, stored.id), target.member, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });
});

describe('添付のダウンロードのキャッシュは今どおり', () => {
  test('添付の 200 の応答は private, no-store（cacheControl の無いバイナリの応答）', async () => {
    const target = await createTarget();
    const { row } = await storedFile(target, { person: target.member });
    const res = await download(target, row.id, { person: target.member });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    await res.arrayBuffer();
  });

  test('添付の 404 も private, no-store', async () => {
    const target = await createTarget();
    const res = await download(target, uuidv7(), { person: target.member });
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
