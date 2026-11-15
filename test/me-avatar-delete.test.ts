// 自分のプロフィール画像を外す操作（me-avatar-delete）と、人を無効にする・有効に戻す操作（user-disable、user-enable）と画像（Issue #1265）。
// 完了条件: me-avatar-delete の後、avatar_url はログインの手段のアイコン（無ければ null）に戻り、前の URL は 404。
// user-disable で無効にすると、その人の user_avatars の行と R2 のファイルが消え、前の URL は 404。user-enable で有効に戻しても
// avatar_url はログインの手段のアイコン（無ければ null）のまま。
// 人が決めたこと: 無効にするときに画像も消し、有効に戻しても戻さない。どの行からも指されない R2 のファイルは件数をログに出すだけ
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { meAvatarDelete, userDisable } from '../src/shared/operations/organization/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { recordingBucket } from './attachment-helpers.ts';
import { jpegImage, pngImage } from './avatar-images.ts';
import {
  avatarObjectKeys,
  avatarRowOf,
  captureLogs,
  deleteAvatar,
  disableUser,
  enableUser,
  expectNotFound,
  getAvatar,
  meAvatarOf,
  memberListAvatars,
  newMember,
  objectBytes,
  setLoginAvatar,
  storeAvatar,
  uploadedUrl,
  userListAvatars,
} from './me-avatar-helpers.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const ICON = 'https://avatars.githubusercontent.com/u/7400001';

async function deleted(target: Target, person: Person, options: Parameters<typeof deleteAvatar>[2] = {}) {
  const res = await deleteAvatar(target, person, options);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { avatar_url: string | null };
  expect(meAvatarDelete.output.safeParse(body).success).toBe(true);
  expect(Object.keys(body)).toEqual(['avatar_url']);
  return body;
}

describe('me-avatar-delete: 外すと、アバターはログインの手段のアイコン（無ければ null）に戻る', () => {
  test('アイコンのある人: 応答と一覧と組織の枠はアイコンに戻り、前の URL は 404、行と R2 のファイルが消える', async () => {
    const target = await createTarget();
    await setLoginAvatar(target.member, ICON);
    const url = await uploadedUrl(target, target.member);
    const row = (await avatarRowOf(target, target.member))!;

    expect(await deleted(target, target.member)).toEqual({ avatar_url: ICON });
    expect(await avatarRowOf(target, target.member)).toBeUndefined();
    expect(await objectBytes(row.object_key)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, target.member.userId)).toEqual([]);
    expect((await memberListAvatars(target, target.leader)).get(target.member.userId!)).toBe(ICON);
    expect((await userListAvatars(target)).get(target.member.userId!)).toBe(ICON);
    expect(await meAvatarOf(target, target.member)).toBe(ICON);
    await expectNotFound(await getAvatar(url, target.leader));
    await expectNotFound(await getAvatar(url, target.member));
  });

  test('アイコンの無い人: 応答と一覧は null に戻る', async () => {
    const target = await createTarget();
    const url = await uploadedUrl(target, target.member);
    expect(await deleted(target, target.member)).toEqual({ avatar_url: null });
    expect((await memberListAvatars(target, target.member)).get(target.member.userId!)).toBeNull();
    expect((await userListAvatars(target)).get(target.member.userId!)).toBeNull();
    expect(await meAvatarOf(target, target.member)).toBeNull();
    await expectNotFound(await getAvatar(url, target.admin));
  });

  test('画像が無いときに外しても 200 で、今のアバター（アイコンか null）を返し、何も変えない', async () => {
    const target = await createTarget();
    await setLoginAvatar(target.leader, ICON);
    expect(await deleted(target, target.leader)).toEqual({ avatar_url: ICON });
    expect(await deleted(target, target.member)).toEqual({ avatar_url: null });
    expect((await memberListAvatars(target, target.leader)).get(target.leader.userId!)).toBe(ICON);
  });

  test('2回続けて外しても、2回目も 200', async () => {
    const target = await createTarget();
    await uploadedUrl(target, target.member);
    await deleted(target, target.member);
    expect(await deleted(target, target.member)).toEqual({ avatar_url: null });
  });

  test('外した後に上げ直すと、新しい URL になり、外す前の URL は 404 のまま', async () => {
    const target = await createTarget();
    const before = await uploadedUrl(target, target.member);
    await deleted(target, target.member);
    const after = await uploadedUrl(target, target.member, jpegImage(30, 30));
    expect(after).not.toBe(before);
    await expectNotFound(await getAvatar(before, target.leader));
    expect((await getAvatar(after, target.leader)).status).toBe(200);
  });
});

describe('me-avatar-delete: 本人だけ', () => {
  test('2人が上げた後、片方が外しても、他方の行、R2 のファイル、URL は残る', async () => {
    const target = await createTarget();
    const leaderUrl = await uploadedUrl(target, target.leader, pngImage(30, 30));
    await uploadedUrl(target, target.member, pngImage(40, 40));
    const leaderRow = await avatarRowOf(target, target.leader);

    await deleted(target, target.member);
    expect(await avatarRowOf(target, target.leader)).toEqual(leaderRow);
    expect(await avatarObjectKeys(target.organization.id, target.leader.userId)).toEqual([leaderRow!.object_key]);
    expect((await getAvatar(leaderUrl, target.member)).status).toBe(200);
    expect((await memberListAvatars(target, target.member)).get(target.leader.userId!)).toBe(leaderUrl);
  });

  test('入力に別の人の user_id を入れても、その人の画像は外さない', async () => {
    const target = await createTarget();
    const leaderUrl = await uploadedUrl(target, target.leader);
    const res = await deleteAvatar(target, target.member, { input: { user_id: target.leader.userId } });
    expect([200, 400]).toContain(res.status);
    expect((await getAvatar(leaderUrl, target.admin)).status).toBe(200);
    expect(await avatarRowOf(target, target.leader)).toBeDefined();
  });

  test('管理者が外しても、自分の画像だけで、ほかの人の画像は残る', async () => {
    const target = await createTarget();
    const memberUrl = await uploadedUrl(target, target.member);
    await uploadedUrl(target, target.admin);
    await deleted(target, target.admin);
    expect(await avatarRowOf(target, target.admin)).toBeUndefined();
    expect((await getAvatar(memberUrl, target.admin)).status).toBe(200);
  });

  test('別の組織の同じアカウントの画像は外さない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    // 処理を通さずに、別の組織のこの人の行を置く（同じアカウントを別の組織の users に結ぶのは手間がかかるので、行だけを見る）
    const stored = await storeAvatar(other.organization, other.member.userId!);
    await uploadedUrl(target, target.member);
    await deleted(target, target.member);
    expect(await avatarRowOf(other, other.member)).toMatchObject({ id: stored.id });
    expect(await objectBytes(stored.object_key)).toEqual(stored.bytes);
  });
});

describe('me-avatar-delete: R2 のファイルを消せないとき', () => {
  test('行は消えて 200、前の URL は 404、ログには件数だけを出す（キーも例外の文も出さない）', async () => {
    const target = await createTarget();
    const url = await uploadedUrl(target, target.member);
    const row = (await avatarRowOf(target, target.member))!;
    const { env: failing } = recordingBucket({
      delete: async () => {
        throw new Error(`R2 の削除に失敗した ${row.object_key}`);
      },
    });
    const logs = captureLogs();
    expect(await deleted(target, target.member, { env: failing })).toEqual({ avatar_url: null });
    expect(await avatarRowOf(target, target.member)).toBeUndefined();
    await expectNotFound(await getAvatar(url, target.leader));
    const counted = logs.filter((line) => line.includes('"count":1'));
    // 添付を消す操作（attachment-delete）と同じく、JSON の1行で件数を出す
    expect(counted, '件数のログ').toHaveLength(1);
    expect(JSON.parse(counted[0]!)).toMatchObject({ count: 1 });
    for (const line of logs) {
      expect(line).not.toContain('/avatars/');
      expect(line).not.toContain('R2 の削除に失敗した');
    }
    await env.ATTACHMENTS.delete(row.object_key);
  });
});

describe('user-disable と user-enable', () => {
  test('定義は R2 を消す道具を受け取る（storage: attachments）', () => {
    expect((userDisable as AnyOperationDefinition).storage).toBe('attachments');
  });

  test('無効にすると、その人の行と R2 のファイルが消え、前の URL は 404。user-list はアイコンに戻る', async () => {
    const target = await createTarget();
    await setLoginAvatar(target.member, ICON);
    const url = await uploadedUrl(target, target.member);
    const row = (await avatarRowOf(target, target.member))!;

    expect((await disableUser(target, target.member.userId!)).status).toBe(200);
    expect(await avatarRowOf(target, target.member)).toBeUndefined();
    expect(await objectBytes(row.object_key)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, target.member.userId)).toEqual([]);
    for (const viewer of [target.leader, target.admin, target.bystander]) {
      await expectNotFound(await getAvatar(url, viewer));
    }
    expect((await userListAvatars(target)).get(target.member.userId!)).toBe(ICON);
  });

  test('有効に戻しても画像は戻らず、avatar_url はアイコン（無ければ null）のまま、前の URL は 404 のまま', async () => {
    const target = await createTarget();
    await setLoginAvatar(target.member, ICON);
    const memberUrl = await uploadedUrl(target, target.member);
    const bystanderUrl = await uploadedUrl(target, target.bystander);
    for (const person of [target.member, target.bystander]) {
      expect((await disableUser(target, person.userId!)).status).toBe(200);
      expect((await enableUser(target, person.userId!)).status).toBe(200);
    }
    const avatars = await userListAvatars(target);
    expect(avatars.get(target.member.userId!)).toBe(ICON);
    expect(avatars.get(target.bystander.userId!)).toBeNull();
    expect(await avatarRowOf(target, target.member)).toBeUndefined();
    expect(await avatarRowOf(target, target.bystander)).toBeUndefined();
    await expectNotFound(await getAvatar(memberUrl, target.leader));
    await expectNotFound(await getAvatar(bystanderUrl, target.leader));
  });

  test('無効にした人の画像だけが消え、ほかの人の画像は残る', async () => {
    const target = await createTarget();
    const leaderUrl = await uploadedUrl(target, target.leader);
    await uploadedUrl(target, target.member);
    const leaderRow = await avatarRowOf(target, target.leader);
    expect((await disableUser(target, target.member.userId!)).status).toBe(200);
    expect(await avatarRowOf(target, target.leader)).toEqual(leaderRow);
    expect(await avatarObjectKeys(target.organization.id, target.leader.userId)).toEqual([leaderRow!.object_key]);
    expect((await getAvatar(leaderUrl, target.admin)).status).toBe(200);
  });

  test('画像の無い人を無効にしても、今までどおり 200', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    expect((await disableUser(target, person.userId!)).status).toBe(200);
  });

  test('R2 のファイルを消せなくても無効にでき、行は同じ書き込みで消え、ログには件数だけを出す', async () => {
    const target = await createTarget();
    const url = await uploadedUrl(target, target.member);
    const row = (await avatarRowOf(target, target.member))!;
    const { env: failing } = recordingBucket({
      delete: async () => {
        throw new Error(`R2 の削除に失敗した ${row.object_key}`);
      },
    });
    const logs = captureLogs();
    expect((await disableUser(target, target.member.userId!, { env: failing })).status).toBe(200);
    expect(await avatarRowOf(target, target.member)).toBeUndefined();
    await expectNotFound(await getAvatar(url, target.leader));
    expect(
      logs.some((line) => line.includes('"count":1')),
      '件数のログ',
    ).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain('/avatars/');
      expect(line).not.toContain('R2 の削除に失敗した');
    }
    await env.ATTACHMENTS.delete(row.object_key);
  });

  test('無効の人を無効にし直しても（書かずに今の値を返す）、ほかの人の画像に触れない', async () => {
    const target = await createTarget();
    const leaderUrl = await uploadedUrl(target, target.leader);
    expect((await disableUser(target, target.member.userId!)).status).toBe(200);
    expect((await disableUser(target, target.member.userId!)).status).toBe(200);
    expect((await getAvatar(leaderUrl, target.admin)).status).toBe(200);
  });
});
