// #740: 応答を差し替えず、添付の書き込みから容量警告・既読・画面表示までを確かめる。
// 生成した組織と使い捨てのアカウントだけを使い、共有 seed の組織・アカウント・ユーザー・通知は変更しない（#1341）。
// 共有 seed のアカウントを一時的な組織に入れると、並べて走る組織の一覧の e2e に混ざるため。実行は CI に任せる。
import { randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { sessionInserts } from '../scripts/seed.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { operationPath, type AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { notificationList, notificationRead } from '../src/shared/operations/notification.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { uuidv7 } from '../src/server/uuid.ts';
import { expect, test } from './fixtures.ts';
import { executeLocalD1 } from './local-d1.ts';

type Who = 'admin' | 'secondAdmin' | 'member';

test('全ワークスペースで容量を共有し、80%超過の管理者通知を一度だけ保存し、上限を超える並行添付を断る', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  test.setTimeout(60_000);
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const origin = new URL(baseURL).origin;
  const organizationId = crypto.randomUUID();
  const slug = `quota-${organizationId.slice(0, 8)}`;
  const [adminId, secondAdminId, memberId, firstWorkspaceId, secondWorkspaceId] = Array.from({ length: 5 }, () =>
    crypto.randomUUID(),
  );
  const at = new Date().toISOString();
  const requests: APIRequestContext[] = [];
  const workspaceIds = `SELECT id FROM workspaces WHERE organization_id = '${organizationId}'`;
  const userIds = `SELECT id FROM users WHERE organization_id = '${organizationId}'`;
  // 一時的な組織に入れる人は、このテストだけのアカウントにする。ログインはセッションの行で用意し、OAuth は往復しない
  const newAccount = (description: string) => ({
    accountId: uuidv7(new Date()),
    token: randomBytes(32).toString('base64url'),
    description,
  });
  const accounts: Record<Who, ReturnType<typeof newAccount>> = {
    admin: newAccount('容量確認の管理者'),
    secondAdmin: newAccount('容量確認の2人目の管理者'),
    member: newAccount('容量確認のメンバー'),
  };
  const accountIds = Object.values(accounts).map((account) => account.accountId);

  // SQL の値はこのテストの UUID・日時・乱数のトークンの hash・定数と、リポジトリにある seed のアカウント ID だけ。
  // 同意の行は seed の admin の公開の行から写す（同意の画面へ移さないため）
  const userInsert = (id: string, who: Who, admin: boolean) =>
    `INSERT INTO users (id, organization_id, account_id, login_provider, login_subject, name, is_admin, created_at, updated_at) ` +
    `VALUES ('${id}', '${organizationId}', '${accounts[who].accountId}', 'github', '${accounts[who].accountId}', '容量確認のメンバー', ${admin ? 1 : 0}, '${at}', '${at}')`;

  try {
    // 共通の表（アカウント、セッション、組織）と組織の中の表は、別の batch で書く
    await executeLocalD1([
      ...accountIds.flatMap((accountId) => [
        `INSERT INTO accounts (id, created_at, updated_at) VALUES ('${accountId}', '${at}', '${at}')`,
        `INSERT INTO account_logins (login_provider, login_subject, account_id, login_name, created_at, updated_at) ` +
          `VALUES ('github', '${accountId}', '${accountId}', 'quota-test', '${at}', '${at}')`,
        `INSERT INTO account_consents (account_id, terms_version, privacy_version, consented_at) ` +
          `SELECT '${accountId}', terms_version, privacy_version, consented_at FROM account_consents WHERE account_id = '${SEED_SESSIONS.admin.accountId}'`,
      ]),
      sessionInserts(Object.values(accounts), new Date()),
      `INSERT INTO organizations (id, slug, name, attachment_quota_bytes, created_by_operator, created_at, updated_at) ` +
        `VALUES ('${organizationId}', '${slug}', '容量確認の工房', 1000, 'github:9000000000000001', '${at}', '${at}')`,
    ]);
    await executeLocalD1([
      userInsert(adminId!, 'admin', true),
      userInsert(secondAdminId!, 'secondAdmin', true),
      userInsert(memberId!, 'member', false),
      ...[firstWorkspaceId, secondWorkspaceId].map(
        (id, index) =>
          `INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at) ` +
          `VALUES ('${id}', '${organizationId}', '容量確認${index + 1}', 'Asia/Tokyo', '${adminId}', '${at}', '${at}')`,
      ),
      ...[firstWorkspaceId, secondWorkspaceId].map(
        (id) =>
          `INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, joined_at) ` +
          `VALUES ('${crypto.randomUUID()}', '${id}', '${memberId}', 'member', '${at.slice(0, 10)}', '${at}')`,
      ),
    ]);
    const client = async (token: string) => {
      const request = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: origin, Cookie: `${sessionCookieName(baseURL)}=${token}` },
      });
      requests.push(request);
      return request;
    };
    const admin = await client(accounts.admin.token);
    const secondAdmin = await client(accounts.secondAdmin.token);
    const member = await client(accounts.member.token);

    // 一時的な組織がある間も、並べて走るテストが使う seed のアカウントの入れる組織に混ざらない
    for (const who of ['admin', 'otherOrg', 'member'] as const) {
      const seed = await client(SEED_SESSIONS[who].token);
      const response = await seed.post(operationPath(myOrganizations), { data: {} });
      expect(response.status()).toBe(200);
      const output = myOrganizations.output.parse(await response.json());
      expect(output.organizations.map((organization) => organization.slug)).not.toContain(slug);
    }
    const post = (request: APIRequestContext, definition: AnyOperationDefinition, input: unknown = {}) =>
      request.post(operationPath(definition, slug), { data: input });
    const notifications = async (request: APIRequestContext) => {
      const response = await post(request, notificationList);
      expect(response.status()).toBe(200);
      return notificationList.output.parse(await response.json());
    };
    const storage = async () => {
      const response = await post(admin, organizationInfo, { include_storage: true });
      expect(response.status()).toBe(200);
      return organizationInfo.output.parse(await response.json()).storage;
    };
    const upload = (workspaceId: string, size: number) =>
      member.post(operationPath(attachmentUpload, slug), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Operation-Input': encodeURIComponent(
            JSON.stringify({ workspace_id: workspaceId, file_name: '容量確認.bin' }),
          ),
        },
        data: Buffer.alloc(size, 0x61),
      });

    // 境界の80%ちょうどでは通知しない。別のワークスペースで1バイト足すと管理者全員に届く。
    expect((await upload(firstWorkspaceId!, 800)).status()).toBe(200);
    expect((await storage())?.used_bytes).toBe(800);
    expect((await notifications(admin)).notifications).toHaveLength(0);
    expect((await notifications(secondAdmin)).notifications).toHaveLength(0);
    expect((await upload(secondWorkspaceId!, 1)).status()).toBe(200);
    // 通知の集計・配信は保存応答を待たせず継続するため、配信完了を待つ。
    await expect.poll(async () => (await notifications(admin)).notifications.length).toBe(1);
    await expect.poll(async () => (await notifications(secondAdmin)).notifications.length).toBe(1);
    const warning = (await notifications(admin)).notifications[0];
    expect(warning).toMatchObject({
      kind: 'attachment_quota_warning',
      payload: { used_bytes: 801, quota_bytes: 1000 },
      read_at: null,
    });
    expect((await notifications(admin)).unread_count).toBe(1);
    const secondWarnings = await notifications(secondAdmin);
    expect(secondWarnings.notifications).toHaveLength(1);
    expect(secondWarnings.notifications[0]?.kind).toBe('attachment_quota_warning');
    expect(secondWarnings.notifications[0]?.id).not.toBe(warning?.id);
    expect((await notifications(member)).notifications).toHaveLength(0);

    // 追加と並行アップロードでも通知は重ならず、残り190バイトを超える要求だけが409になる。
    expect((await upload(firstWorkspaceId!, 9)).status()).toBe(200);
    const concurrent = await Promise.all([upload(firstWorkspaceId!, 190), upload(secondWorkspaceId!, 190)]);
    expect(concurrent.map((response) => response.status()).sort()).toEqual([200, 409]);
    for (const response of concurrent.filter((response) => response.status() === 409)) {
      expect(await response.json()).toMatchObject({ error: { code: 'attachment_quota_exceeded' } });
    }
    const full = await storage();
    expect(full?.used_bytes).toBe(1000);
    expect(full?.quota_bytes).toBe(1000);
    expect(full?.workspaces.reduce((sum, row) => sum + row.used_bytes, 0)).toBe(1000);
    for (const workspaceId of [firstWorkspaceId!, secondWorkspaceId!]) {
      const response = await upload(workspaceId, 1);
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'attachment_quota_exceeded' } });
    }
    expect((await notifications(admin)).notifications).toHaveLength(1);
    expect((await notifications(secondAdmin)).notifications).toHaveLength(1);
    const memberInfo = await post(member, organizationInfo);
    expect(memberInfo.status()).toBe(200);
    expect(organizationInfo.output.parse(await memberInfo.json()).storage).toBeNull();

    // 他人は既読にできない。実際に保存した警告が一覧に出て、本人の既読だけが保存される。
    if (warning === undefined) throw new Error('保存された容量警告が無い');
    const forbiddenRead = await post(member, notificationRead, { id: warning.id });
    expect(forbiddenRead.status()).toBe(404);
    expect(await forbiddenRead.json()).toMatchObject({ error: { code: 'not_found' } });
    await context.addCookies([
      { name: sessionCookieName(baseURL), value: accounts.admin.token, url: baseURL, httpOnly: true },
    ]);
    await page.goto(`/${slug}/notifications`);
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
    await expect(page.locator('.feed li')).toHaveCount(1);
    await expect(page.locator('.feed')).toContainText('上限の80%を超えました');
    await expect(page.getByRole('link', { name: '組織の管理を開く' })).toHaveAttribute('href', `/${slug}/admin`);
    await page.getByRole('button', { name: '既読にする', exact: true }).click();
    await expect(page.getByRole('button', { name: '既読にする', exact: true })).toHaveCount(0);
    const read = await notifications(admin);
    expect(read.unread_count).toBe(0);
    expect(read.notifications[0]?.read_at).not.toBeNull();
    expect((await notifications(secondAdmin)).unread_count).toBe(1);

    await page.goto(`/${slug}/admin`);
    await expect(page.getByRole('region', { name: '添付ファイルと Wiki の容量' })).toContainText(
      '新しく添付できません',
    );
    await expect(page.getByRole('region', { name: '添付ファイルと Wiki の容量' })).toContainText('1,000 バイト使用中');
  } finally {
    // 画面と要求の後始末が投げても（タイムアウトで page が閉じたときなど）、D1 の後始末は流す
    try {
      await page.goto('about:blank');
      await Promise.all(requests.map((request) => request.dispose()));
    } finally {
      // 組織の中の表を消してから、共通の表（アカウント、セッション、組織）を消す
      await executeLocalD1([
        `DELETE FROM notifications WHERE user_id IN (${userIds})`,
        `DELETE FROM change_logs WHERE organization_id = '${organizationId}'`,
        `DELETE FROM attachments WHERE workspace_id IN (${workspaceIds})`,
        `DELETE FROM memberships WHERE workspace_id IN (${workspaceIds})`,
        `DELETE FROM workspaces WHERE organization_id = '${organizationId}'`,
        `DELETE FROM users WHERE organization_id = '${organizationId}'`,
      ]);
      await executeLocalD1([
        ...accountIds.flatMap((accountId) => [
          `DELETE FROM sessions WHERE account_id = '${accountId}'`,
          `DELETE FROM account_consents WHERE account_id = '${accountId}'`,
          `DELETE FROM account_logins WHERE account_id = '${accountId}'`,
          `DELETE FROM accounts WHERE id = '${accountId}'`,
        ]),
        `DELETE FROM organizations WHERE id = '${organizationId}'`,
      ]);
      // R2 はこの使い捨てローカル環境だけに残る。共有 seed のオブジェクトを列挙・削除しない。
    }
  }
});
