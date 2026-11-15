// プロフィール画像（Issue #1265）の done-check のレビューで足したテスト。
// batch() の応答だけが失われたとき、R2 に書いている間に無効にされたとき、HEAD で R2 の中身を読まないこと
import { afterEach, describe, expect, test, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { recordingBucket } from './attachment-helpers.ts';
import { jpegImage, pngImage } from './avatar-images.ts';
import {
  app,
  avatarIdOf,
  avatarObjectKeys,
  avatarRowOf,
  captureLogs,
  disableUser,
  expectError,
  getAvatar,
  newMember,
  uploadAvatar,
  uploadedUrl,
} from './me-avatar-helpers.ts';
import { createTarget, testEnv } from './operations/world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('batch() が書いた後に応答だけが失われたとき', () => {
  test('行が新しい画像を指していれば、成功として返し、新しいファイルを残して前のファイルを消す', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    await uploadedUrl(target, person, pngImage(20, 20));
    const before = (await avatarRowOf(target, person))!;
    const lost = envWithD1Hooks(testEnv, {
      afterBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "user_avatars"'))) throw new Error('fictional-lost-reply');
      },
    });
    const res = await uploadAvatar(target, person, jpegImage(40, 40), { env: lost });
    expect(res.status).toBe(200);
    const row = (await avatarRowOf(target, person))!;
    expect(row.content_type).toBe('image/jpeg');
    expect(row.id).not.toBe(before.id);
    expect(((await res.json()) as { avatar_url: string }).avatar_url).toBe(`/api/${target.slug}/user-avatar/${row.id}`);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([row.object_key]);
    expect((await getAvatar(`/api/${target.slug}/user-avatar/${row.id}`, target.leader)).status).toBe(200);
  });

  test('引き直しも失敗したときは、新しいファイルを消さない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    let lostReply = false;
    const lost = envWithD1Hooks(testEnv, {
      afterBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "user_avatars"'))) {
          lostReply = true;
          throw new Error('fictional-lost-reply');
        }
      },
      afterQuery: async (sql) => {
        if (lostReply && sql.startsWith('select "id" from "user_avatars"')) throw new Error('fictional-reread-failure');
      },
    });
    const logs = captureLogs();
    const res = await uploadAvatar(target, person, pngImage(40, 40), {
      env: lost,
      headers: { 'cf-ray': 'ray-unresolved' },
    });
    expect(res.status).toBe(500);
    const row = (await avatarRowOf(target, person))!;
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([row.object_key]);
    // 残したファイルの件数だけをログに出し、キーは出さない
    const unresolved = logs
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .find((entry) => entry['count'] === 1);
    expect(unresolved).toMatchObject({ operation: 'me-avatar-upload', count: 1 });
    expect(logs.join('\n')).not.toContain('/avatars/');
  });
});

test('R2 に書いている間に管理者がその人を無効にすると、上げる操作は 409 の conflict', async () => {
  const target = await createTarget();
  const person = await newMember(target);
  let disabled: Response | undefined;
  const { env: racing } = recordingBucket({
    put: async (...args: unknown[]) => {
      disabled ??= await disableUser(target, person.userId!);
      return (env.ATTACHMENTS.put as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  });
  const res = await uploadAvatar(target, person, pngImage(40, 40), { env: racing });
  expect(disabled?.status, '割り込ませた無効化').toBe(200);
  await expectError(res, 409, 'conflict');
});

test('HEAD は R2 の中身を読まず（get を呼ばず）、ファイルの大きさを返す', async () => {
  const target = await createTarget();
  const bytes = pngImage(30, 30);
  const url = await uploadedUrl(target, target.member, bytes);
  const { env: headOnly, calls } = recordingBucket({
    get: () => {
      throw new Error('HEAD で get を呼んだ');
    },
  });
  const res = await app.request(
    url,
    { method: 'HEAD', headers: { Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${target.leader.token}` } },
    headOnly,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Length')).toBe(String(bytes.byteLength));
  expect(calls.map((call) => call.method)).toEqual(['head']);
  expect(avatarIdOf(target, url)).toBeTruthy();
});
