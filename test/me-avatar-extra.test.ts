// プロフィール画像（Issue #1265）の補いのテスト。HEAD の応答、cacheControl の値の形、無効にした後の上げ直し、
// 組織の枠の me.avatar_url が上げ直しで変わること
import { describe, expect, test } from 'vitest';
import { assertOperationDefinition, type AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { userAvatar } from '../src/shared/operations/organization/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { pngImage } from './avatar-images.ts';
import {
  app,
  avatarIdOf,
  avatarObjectKeys,
  avatarRowOf,
  disableUser,
  enableUser,
  expectNotFound,
  getAvatar,
  meAvatarOf,
  newMember,
  uploadAvatar,
  uploadedUrl,
} from './me-avatar-helpers.ts';
import { createTarget, testEnv } from './operations/world.ts';

describe('HEAD', () => {
  test('HEAD で開いても 200 で、本文は無く、200 のキャッシュと nosniff が付く', async () => {
    const target = await createTarget();
    const url = await uploadedUrl(target, target.member, pngImage(30, 30));
    const res = await app.request(
      url,
      {
        method: 'HEAD',
        headers: { Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${target.leader.token}` },
      },
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.arrayBuffer()).toHaveProperty('byteLength', 0);
  });
});

describe('cacheControl の値の形', () => {
  const forged = (cacheControl: unknown) => ({ ...userAvatar, cacheControl }) as unknown as AnyOperationDefinition;

  test.each(['privateer', 'private,\nmax-age=3600', 'private; max-age=3600'])(
    'private で始まっても %j は断る',
    (value) => {
      expect(() => assertOperationDefinition(forged(value))).toThrow(/cacheControl/);
    },
  );

  test('private の後ろに指示を並べた値は通す', () => {
    expect(() => assertOperationDefinition(forged('private, max-age=60, must-revalidate'))).not.toThrow();
  });
});

describe('無効にした後の上げ直しと、組織の枠の me.avatar_url', () => {
  test('無効の人の上げる操作は組織に入れず、有効に戻した後に上げ直せば新しい画像になる', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const first = await uploadedUrl(target, person);
    expect((await disableUser(target, person.userId!)).status).toBe(200);
    expect((await uploadAvatar(target, person)).status).toBeGreaterThanOrEqual(400);
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
    expect((await enableUser(target, person.userId!)).status).toBe(200);
    await expectNotFound(await getAvatar(first, target.leader));
  });

  test('上げ直すたびに me.avatar_url が新しい URL になる', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const first = await uploadedUrl(target, person);
    expect(await meAvatarOf(target, person)).toBe(first);
    const second = await uploadedUrl(target, person, pngImage(20, 20));
    expect(await meAvatarOf(target, person)).toBe(second);
    expect(avatarIdOf(target, second)).not.toBe(avatarIdOf(target, first));
  });
});
