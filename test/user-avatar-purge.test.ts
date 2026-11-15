// 組織を消す SQL（scripts/purge-organization-sql.ts）がプロフィール画像の行（user_avatars）を消すこと（Issue #1265）。
// user_avatars は users を指すので、users より前に消す。R2 のファイルは <組織>/avatars/ の下にあり、組織を消す手順で組織の接頭辞ごと消える。
// 人が1文ずつ流すのと同じく、テストの D1 に1文ずつ順に流して確かめる（test/purge-organization.test.ts と同じ流し方）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { purgeOrganizationCountSql, purgeOrganizationSql } from '../scripts/purge-organization-sql.ts';
import { firstRowForTest, runStatementsForTest, sqlLines } from '../src/server/db/testing.ts';
import { AT, createOrganization, createUser, uuidv7 } from './factories.ts';
import { avatarRows, storeAvatar } from './me-avatar-helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const dateOf = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const EXPIRED = () => ({ suspended_at: AT, purge_on: dateOf(-31) });

async function organizationWithAvatars(overrides: Parameters<typeof createOrganization>[0] = {}) {
  const organization = await createOrganization(overrides);
  const first = await createUser(organization, { is_admin: 1 });
  const second = await createUser(organization);
  await storeAvatar(organization, first.id);
  await storeAvatar(organization, second.id);
  return organization;
}

describe('purge-organization と user_avatars', () => {
  test('user_avatars を消す文があり、users を消す文より前にある', () => {
    const statements = sqlLines(purgeOrganizationSql(uuidv7()));
    const tables = statements.map((statement) => /^DELETE FROM (\w+) /.exec(statement)?.[1]);
    const avatars = tables.indexOf('user_avatars');
    expect(avatars, 'user_avatars を消す文').toBeGreaterThanOrEqual(0);
    expect(tables.filter((table) => table === 'user_avatars')).toHaveLength(1);
    expect(avatars).toBeLessThan(tables.indexOf('users'));
  });

  test('消す予定日を過ぎた解約の組織の行だけが消え、ほかの組織の行は残る', async () => {
    const expired = await organizationWithAvatars(EXPIRED());
    const kept = await organizationWithAvatars();
    const keptRows = await avatarRows(kept.id);
    expect(await avatarRows(expired.id)).toHaveLength(2);

    await runStatementsForTest(env, sqlLines(purgeOrganizationSql(expired.id)));
    expect(await avatarRows(expired.id)).toEqual([]);
    expect(await avatarRows(kept.id)).toEqual(keptRows);
  });

  test('停止していない組織と、予定日の前の組織では消えない', async () => {
    for (const overrides of [{}, { suspended_at: AT, purge_on: dateOf(1) }]) {
      const organization = await organizationWithAvatars(overrides);
      await runStatementsForTest(env, sqlLines(purgeOrganizationSql(organization.id)));
      expect(await avatarRows(organization.id)).toHaveLength(2);
    }
  });

  test('数える文は user_avatars の行の数を返し、流した後は 0 になる', async () => {
    const expired = await organizationWithAvatars(EXPIRED());
    expect((await firstRowForTest(env, purgeOrganizationCountSql(expired.id)))?.user_avatars).toBe(2);
    await runStatementsForTest(env, sqlLines(purgeOrganizationSql(expired.id)));
    expect((await firstRowForTest(env, purgeOrganizationCountSql(expired.id)))?.user_avatars).toBe(0);
  });

  test('R2 のファイルは組織の接頭辞（<組織の ID>/）の下にあり、組織を消す手順の接頭辞で拾える', async () => {
    const organization = await createOrganization(EXPIRED());
    const user = await createUser(organization);
    const stored = await storeAvatar(organization, user.id);
    const listed = await env.ATTACHMENTS.list({ prefix: `${organization.id}/` });
    expect(listed.objects.map((object) => object.key)).toContain(stored.object_key);
  });
});
