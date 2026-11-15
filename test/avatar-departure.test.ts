// 組織に入れなくなった人のプロフィール画像（Issue #1273）。
// 完了条件: 一般のメンバーが最後のワークスペースを membership-leave で抜けるか、リーダーか管理者に外されるか、今の所属が無い管理者の指名を
// user-admin-update で解除されると、その人の user_avatars の行と R2 のファイルが消え、前の URL は 404、user-list の avatar_url は
// ログインの手段のアイコン（無ければ null）になる。管理者が最後の所属を抜けたとき、ほかの所属（閉じたワークスペースの所属を含む）が残るとき、
// 所属のある人の指名を解除したときは消えない。招待を承諾して戻っても画像は戻らない。入れなくなる書き込みが先に確定した後の
// me-avatar-upload は行を書かず 409 で、書いたファイルも残らない
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { userAdminUpdate } from '../src/shared/operations/organization/index.ts';
import { invitationAccept, membershipLeave } from '../src/shared/operations/workspace/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { recordingBucket } from './attachment-helpers.ts';
import { pngImage } from './avatar-images.ts';
import { createInvitation, createMembership, createWorkspace } from './factories.ts';
import {
  app,
  avatarObjectKeys,
  avatarRowOf,
  captureLogs,
  expectError,
  expectNotFound,
  getAvatar,
  meAvatarOf,
  newMember,
  objectBytes,
  setLoginAvatar,
  storeAvatar,
  uploadAvatar,
  uploadedUrl,
  userListAvatars,
} from './me-avatar-helpers.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, withNewSession, type Person, type Target } from './operations/world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const ICON = 'https://avatars.githubusercontent.com/u/7400002';

function leave(
  target: Target,
  actor: Person,
  person: Person,
  options: { workspaceId?: string; env?: Env } = {},
): Promise<Response> {
  return post(app, membershipLeave, {
    slug: target.slug,
    token: actor.token,
    body: { workspace_id: options.workspaceId ?? target.workspace.id, user_id: person.userId },
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function setAdmin(target: Target, person: Person, isAdmin: boolean, options: { env?: Env } = {}): Promise<Response> {
  return post(app, userAdminUpdate, {
    slug: target.slug,
    token: target.admin.token,
    body: { user_id: person.userId, is_admin: isAdmin },
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

// 画像が消えたこと: 行と R2 のファイルが無く、前の URL は同じ組織のほかの人から 404、user-list はアイコン（無ければ null）
async function expectRemoved(target: Target, person: Person, url: string, icon: string | null): Promise<void> {
  expect(await avatarRowOf(target, person)).toBeUndefined();
  expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
  await expectNotFound(await getAvatar(url, target.admin));
  await expectNotFound(await getAvatar(url, target.leader));
  expect((await userListAvatars(target)).get(person.userId!)).toBe(icon);
}

// 画像が残ったこと: 行と R2 のファイルがあり、前の URL は 200、user-list はその URL
async function expectKept(target: Target, person: Person, url: string): Promise<void> {
  const row = await avatarRowOf(target, person);
  expect(row).toBeDefined();
  expect(await objectBytes(row!.object_key)).toBeDefined();
  expect((await getAvatar(url, target.admin)).status).toBe(200);
  expect((await userListAvatars(target)).get(person.userId!)).toBe(url);
}

describe('定義', () => {
  test('membership-leave と user-admin-update は R2 を消す道具を受け取る（storage: attachments）', () => {
    expect((membershipLeave as AnyOperationDefinition).storage).toBe('attachments');
    expect((userAdminUpdate as AnyOperationDefinition).storage).toBe('attachments');
  });
});

describe('組織に入れなくなると、画像が消える', () => {
  test('一般のメンバーが最後のワークスペースを自分で抜けると、行と R2 のファイルが消え、user-list はアイコンになる', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    await setLoginAvatar(person, ICON);
    const url = await uploadedUrl(target, person);

    expect((await leave(target, person, person)).status).toBe(200);
    await expectRemoved(target, person, url, ICON);
  });

  test('アイコンの無い人は、user-list の avatar_url が null になる', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    expect((await leave(target, person, person)).status).toBe(200);
    await expectRemoved(target, person, url, null);
  });

  for (const role of ['leader', 'admin'] as const) {
    test(`${role === 'leader' ? 'リーダー' : '管理者'}が最後のワークスペースから外しても消える`, async () => {
      const target = await createTarget();
      const person = await newMember(target);
      const url = await uploadedUrl(target, person);
      const actor = role === 'leader' ? target.leader : target.admin;
      expect((await leave(target, actor, person)).status).toBe(200);
      await expectRemoved(target, person, url, null);
    });
  }

  test('ほかの人の画像は消えない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    await uploadedUrl(target, person);
    const leaderUrl = await uploadedUrl(target, target.leader);
    const bystanderUrl = await uploadedUrl(target, target.bystander);
    expect((await leave(target, person, person)).status).toBe(200);
    expect((await getAvatar(leaderUrl, target.admin)).status).toBe(200);
    expect((await getAvatar(bystanderUrl, target.admin)).status).toBe(200);
  });

  test('今の所属が無い管理者の指名を解除すると消える', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true });
    await setLoginAvatar(person, ICON);
    const url = await uploadedUrl(target, person);
    expect((await setAdmin(target, person, false)).status).toBe(200);
    await expectRemoved(target, person, url, ICON);
  });

  test('R2 のファイルを消せなくても、離脱は 200 で行は消え、ログには件数だけを出す', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    const row = (await avatarRowOf(target, person))!;
    const { env: failing } = recordingBucket({
      delete: async () => {
        throw new Error(`R2 の削除に失敗した ${row.object_key}`);
      },
    });
    const logs = captureLogs();
    expect((await leave(target, person, person, { env: failing })).status).toBe(200);
    expect(await avatarRowOf(target, person)).toBeUndefined();
    await expectNotFound(await getAvatar(url, target.admin));
    const counted = logs.filter((line) => line.includes('"count":1'));
    expect(counted, '件数のログ').toHaveLength(1);
    expect(JSON.parse(counted[0]!)).toMatchObject({ operation: 'membership-leave', count: 1 });
    for (const line of logs) {
      expect(line).not.toContain('/avatars/');
      expect(line).not.toContain('R2 の削除に失敗した');
    }
    await env.ATTACHMENTS.delete(row.object_key);
  });
});

describe('組織に入れるままなら、画像は消えない', () => {
  test('管理者が最後の所属を抜けても消えない', async () => {
    const target = await createTarget();
    const person = await createPerson({
      organization: target.organization,
      admin: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const url = await uploadedUrl(target, person);
    expect((await leave(target, person, person)).status).toBe(200);
    await expectKept(target, person, url);
  });

  test('ほかのワークスペースの所属が残れば消えない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    await createMembership(target.organization, target.otherWorkspace.id, person.userId!);
    const url = await uploadedUrl(target, person);
    expect((await leave(target, target.leader, person)).status).toBe(200);
    await expectKept(target, person, url);
  });

  test('閉じたワークスペースの所属だけが残っても消えない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    await createMembership(target.organization, closed.id, person.userId!);
    const url = await uploadedUrl(target, person);
    expect((await leave(target, person, person)).status).toBe(200);
    await expectKept(target, person, url);
  });

  test('所属のある人の指名を解除しても消えない', async () => {
    const target = await createTarget();
    const person = await createPerson({
      organization: target.organization,
      admin: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const url = await uploadedUrl(target, person);
    expect((await setAdmin(target, person, false)).status).toBe(200);
    await expectKept(target, person, url);
  });

  test('指名するときは消えない', async () => {
    const target = await createTarget();
    const url = await uploadedUrl(target, target.member);
    expect((await setAdmin(target, target.member, true)).status).toBe(200);
    await expectKept(target, target.member, url);
  });

  test('断られた離脱（ほかの人が外そうとした）では消えない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    const other = await newMember(target);
    expect((await leave(target, other, person)).status).toBe(403);
    await expectKept(target, person, url);
  });
});

describe('この要求で入れなくなった人の画像だけを消す', () => {
  test('読んでから書くまでに別の要求が先に所属を終えたとき、後の離脱は、その人に残っていた行を消さず、R2 のファイルも残す', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    let stored: Awaited<ReturnType<typeof storeAvatar>> | undefined;
    // 後の要求が所属を読んだ直後に、先の要求が同じ所属を終え、この版より前に抜けた人のように行だけが残った状態を作る
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (stored !== undefined || !sql.startsWith('select "m"."id", "m"."role"')) return;
        expect((await leave(target, target.leader, person)).status, '先の離脱').toBe(200);
        stored = await storeAvatar(target.organization, person.userId!);
      },
    });
    expect((await leave(target, person, person, { env: racing })).status).toBe(404);
    expect(stored, '割り込ませた離脱').toBeDefined();
    expect(await avatarRowOf(target, person)).toMatchObject({ id: stored!.id });
    expect(await objectBytes(stored!.object_key)).toEqual(stored!.bytes);
    await env.ATTACHMENTS.delete(stored!.object_key);
  });

  test('読んでから書くまでに別の要求が先に解除したとき、後の解除は、その人に残っていた行を消さない', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true });
    let stored: Awaited<ReturnType<typeof storeAvatar>> | undefined;
    // 後の要求が相手を読んだ直後に、先の要求が同じ人を解除し、行だけが残った状態を作る
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (stored !== undefined || !sql.startsWith('select "id", "is_admin", "disabled_at", "login_provider"')) return;
        expect((await setAdmin(target, person, false)).status, '先の解除').toBe(200);
        stored = await storeAvatar(target.organization, person.userId!);
      },
    });
    const res = await setAdmin(target, person, false, { env: racing });
    expect(stored, '割り込ませた解除').toBeDefined();
    // 先の解除が済んでいるので、後の要求は今の値を返す
    expect(res.status).toBe(200);
    expect(await avatarRowOf(target, person)).toMatchObject({ id: stored!.id });
    expect(await objectBytes(stored!.object_key)).toEqual(stored!.bytes);
    await env.ATTACHMENTS.delete(stored!.object_key);
  });

  test('別の組織の画像は、離脱でも解除でも消さない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const stored = await storeAvatar(other.organization, other.member.userId!);
    const person = await newMember(target);
    await uploadedUrl(target, person);
    const admin = await createPerson({ organization: target.organization, admin: true });
    await uploadedUrl(target, admin);
    expect((await leave(target, person, person)).status).toBe(200);
    expect((await setAdmin(target, admin, false)).status).toBe(200);
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarRowOf(target, admin)).toBeUndefined();
    expect(await avatarRowOf(other, other.member)).toMatchObject({ id: stored.id });
    expect(await objectBytes(stored.object_key)).toEqual(stored.bytes);
    expect((await getAvatar(`/api/${other.slug}/user-avatar/${stored.id}`, other.admin)).status).toBe(200);
  });

  test('解除で R2 のファイルを消せなくても 200 で行は消え、ログには user-admin-update の件数だけを出す', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true });
    const url = await uploadedUrl(target, person);
    const row = (await avatarRowOf(target, person))!;
    const { env: failing } = recordingBucket({
      delete: async () => {
        throw new Error(`R2 の削除に失敗した ${row.object_key}`);
      },
    });
    const logs = captureLogs();
    expect((await setAdmin(target, person, false, { env: failing })).status).toBe(200);
    expect(await avatarRowOf(target, person)).toBeUndefined();
    await expectNotFound(await getAvatar(url, target.admin));
    const counted = logs.filter((line) => line.includes('"count":1'));
    expect(counted, '件数のログ').toHaveLength(1);
    expect(JSON.parse(counted[0]!)).toMatchObject({ operation: 'user-admin-update', count: 1 });
    for (const line of logs) {
      expect(line).not.toContain('/avatars/');
      expect(line).not.toContain('R2 の削除に失敗した');
    }
    await env.ATTACHMENTS.delete(row.object_key);
  });
});

describe('戻っても画像は戻らない', () => {
  for (const by of ['self', 'leader'] as const) {
    test(`${by === 'self' ? '自分で抜けた' : '外された'}人が招待を承諾して戻っても、avatar_url はアイコンのままで前の URL は 404`, async () => {
      const target = await createTarget();
      const person = await newMember(target);
      await setLoginAvatar(person, ICON);
      const url = await uploadedUrl(target, person);
      expect((await leave(target, by === 'self' ? person : target.leader, person)).status).toBe(200);

      const invitation = await createInvitation(
        target.organization,
        target.workspace.id,
        target.admin.userId!,
        person.login,
      );
      // 外された人は前のセッションで入り直せないので、新しいセッションで承諾する
      const returning = by === 'self' ? person : await withNewSession(person);
      const accepted = await post(app, invitationAccept, {
        slug: target.slug,
        token: returning.token,
        body: { invitation_id: invitation.id },
      });
      expect(accepted.status).toBe(200);
      expect(await avatarRowOf(target, person)).toBeUndefined();
      expect(await meAvatarOf(target, returning)).toBe(ICON);
      expect((await userListAvatars(target)).get(person.userId!)).toBe(ICON);
      await expectNotFound(await getAvatar(url, returning));
    });
  }
});

describe('上げる操作と、組織に入れなくなる書き込みの競合', () => {
  test('R2 に書いている間に最後のワークスペースから外されると、上げる操作は 409 で、行もファイルも残らない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    let left: Response | undefined;
    const { env: racing } = recordingBucket({
      put: async (...args: unknown[]) => {
        left ??= await leave(target, target.leader, person);
        return (env.ATTACHMENTS.put as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    });
    const res = await uploadAvatar(target, person, pngImage(40, 40), { env: racing });
    expect(left?.status, '割り込ませた離脱').toBe(200);
    await expectError(res, 409, 'conflict');
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
  });

  test('差し替えの途中で今の所属が無い管理者の指名を解除されると、409 で、前の行は解除が消しており、ファイルも残らない', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true });
    await uploadedUrl(target, person);
    let unset: Response | undefined;
    const { env: racing } = recordingBucket({
      put: async (...args: unknown[]) => {
        unset ??= await setAdmin(target, person, false);
        return (env.ATTACHMENTS.put as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    });
    const res = await uploadAvatar(target, person, pngImage(40, 40), { env: racing });
    expect(unset?.status, '割り込ませた解除').toBe(200);
    await expectError(res, 409, 'conflict');
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
  });

  test('組織に入れるままの離脱（ほかの所属が残る）と並んでも、上げる操作は成功する', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    await createMembership(target.organization, target.otherWorkspace.id, person.userId!);
    let left: Response | undefined;
    const { env: racing } = recordingBucket({
      put: async (...args: unknown[]) => {
        left ??= await leave(target, target.leader, person);
        return (env.ATTACHMENTS.put as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    });
    const res = await uploadAvatar(target, person, pngImage(40, 40), { env: racing });
    expect(left?.status).toBe(200);
    expect(res.status).toBe(200);
    expect(await avatarRowOf(target, person)).toBeDefined();
  });
});
