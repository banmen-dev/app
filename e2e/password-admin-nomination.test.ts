// E2E の Worker に運用者の設定が無いので、指名を発行する操作だけを差し替える（operator.test.ts と同じ）。
// 使い捨ての指名を手元の D1 に置き、URL を開いてから登録・同意・組織の管理へ進むまでは本物の API を使う。
import { randomBytes } from 'node:crypto';
import { tokenHash } from '../scripts/seed.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { createOrganization } from '../src/shared/operations/operator/create-organization.ts';
import { listOrganizations } from '../src/shared/operations/operator/list-organizations.ts';
import { organizationAdminReassign } from '../src/shared/operations/operator/organization-admin-reassign.ts';
import { PASSWORD_LOGIN_ENABLED } from '../src/shared/password-login-enabled.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { executeLocalD1, resetPasswordLoginRateLimits } from './local-d1.ts';
import { mockOperation, routeOperation } from './operations.ts';

test.skip(!PASSWORD_LOGIN_ENABLED, 'メールアドレスとパスワードのログインを閉じている間は飛ばす');

test('運用者が管理者を指名し直し、本人が新しい URL で表示名とパスワードを決めて組織に入る', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL が無い');
  const organizationId = crypto.randomUUID();
  const slug = `password-admin-${organizationId.slice(-12)}`;
  const organizationName = 'しらさぎ工房';
  const displayName = 'カナエ';
  const originalEmail = `old-${organizationId}@example.test`;
  const email = `admin-${organizationId}@example.test`;
  const password = 'shirasagi-koubou-2026';
  const now = new Date();
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const nomination = (address: string) => {
    const secret = randomBytes(32).toString('base64url');
    return {
      url: new URL(`/invite/password#${secret}`, baseURL).href,
      write:
        'INSERT INTO users (id, organization_id, login_provider, login_email, claim_token_hash, claim_expires_at, name, is_admin, created_at, updated_at) ' +
        `VALUES ('${crypto.randomUUID()}', '${organizationId}', 'password', '${address}', '${tokenHash(secret)}', '${expiresAt}', '指名済み', 1, '${at}', '${at}')`,
    };
  };
  const original = nomination(originalEmail);
  const replacement = nomination(email);
  const accountIds =
    "SELECT account_id FROM account_logins WHERE login_provider = 'password' AND login_subject IN " +
    `(SELECT login_subject FROM password_credentials WHERE email IN ('${originalEmail}', '${email}'))`;
  const recipient = await browser.newContext({ baseURL });
  try {
    await resetPasswordLoginRateLimits();
    await signIn(context, baseURL, 'operator');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const organizations: OutputOf<typeof listOrganizations>['organizations'] = [];
    await mockOperation(page, listOrganizations, { organizations });
    await routeOperation(page, createOrganization, async (call) => {
      expect(call.input).toEqual({
        slug,
        name: organizationName,
        admin: { provider: 'password', email: originalEmail },
      });
      await executeLocalD1([
        'INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) ' +
          `VALUES ('${organizationId}', '${slug}', '${organizationName}', 'github:9000000000000001', '${at}', '${at}')`,
        original.write,
      ]);
      organizations.push({
        slug,
        name: organizationName,
        kind: 'team',
        suspended_at: null,
        purge_on: null,
        purge_due: false,
        created_at: at,
        admin_status: 'pending',
        seats: { used: 0, limit: 15 },
        workspace_count: 0,
        task_count: 0,
        attachment_quota_bytes: 32212254720,
        attachment_used_bytes: 0,
        last_used_at: null,
        self_created: false,
        trial_ends_on: null,
        trial_expired: false,
        contract: null,
      });
      await call.fulfill({
        slug,
        name: organizationName,
        admin_login_name: originalEmail,
        invite: { url: original.url, expires_at: expiresAt },
      });
    });
    await routeOperation(page, organizationAdminReassign, async (call) => {
      expect(call.input).toEqual({ slug, admin: { provider: 'password', email } });
      await executeLocalD1([
        `DELETE FROM users WHERE organization_id = '${organizationId}' AND login_email = '${originalEmail}'`,
        replacement.write,
      ]);
      await call.fulfill({ slug, admin_login_name: email, invite: { url: replacement.url, expires_at: expiresAt } });
    });

    await page.goto('/operator');
    await page.getByRole('button', { name: '組織を作る' }).click();
    const dialog = page.getByRole('dialog');
    const method = dialog.getByRole('radio', { name: 'メールアドレスとパスワード', exact: true });
    const emailField = dialog.getByLabel('メールアドレス', { exact: true });
    const inviteUrl = dialog.getByLabel('指名の URL', { exact: true });
    const close = dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる', exact: true });

    await dialog.getByLabel('URL の名前（slug）').fill(slug);
    await dialog.getByLabel('表示名', { exact: true }).fill(organizationName);
    await method.check();
    await emailField.fill(originalEmail);
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(inviteUrl).toHaveValue(original.url);
    await expect(dialog).toContainText('期限は14日');
    await expect(dialog).toContainText('この画面を閉じると二度と出せません');
    await close.click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: organizationName });
    await expect(row).toContainText('管理者は指名済み、ログイン待ち');

    const reassign = page.getByRole('button', { name: `「${organizationName}」の管理者を指名` });
    await reassign.click();
    await expect(inviteUrl).toHaveCount(0);
    await method.check();
    await emailField.fill(email);
    await dialog.getByRole('button', { name: '指名する', exact: true }).click();
    await expect(inviteUrl).toHaveValue(replacement.url);
    await dialog.getByRole('button', { name: 'コピー', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(replacement.url);
    const copiedUrl = await page.evaluate(() => navigator.clipboard.readText());
    await close.click();
    await expect(dialog).toBeHidden();

    const registration = await recipient.newPage();
    const response = await registration.goto(original.url);
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(registration.getByRole('alert')).toContainText('URL は使えません');

    const registrationUrl = new URL('/invite/password', baseURL).href;
    await expect(registration).toHaveURL(registrationUrl);
    // 新しい指名 URL は同じ文書でフラグメントだけが変わる。
    expect(await registration.goto(copiedUrl)).toBeNull();
    const nominatedEmail = registration.getByLabel('メールアドレス', { exact: true });
    await expect(nominatedEmail).toHaveValue(email);
    await expect(nominatedEmail).not.toBeEditable();
    await expect(registration).toHaveURL(registrationUrl);
    await registration.getByLabel('表示名', { exact: true }).fill(displayName);
    await registration.getByLabel('パスワード', { exact: true }).fill(password);
    await registration.getByLabel('パスワード（確認）', { exact: true }).fill(password);
    const register = registration.getByRole('button', { name: '登録して組織に入る', exact: true });
    await register.click();

    await expect(registration).toHaveURL(new URL(`/consent?return_to=%2F${slug}`, baseURL).href);
    await registration.getByRole('checkbox', { name: '利用規約とプライバシーポリシーを確認し、同意します' }).check();
    await registration.getByRole('button', { name: '同意して進む' }).click();
    await expect(registration).toHaveURL(new URL(`/${slug}`, baseURL).href);
    await expect(registration.locator('.me')).toContainText(displayName);

    await registration.goto(`/${slug}/admin`);
    await expect(registration.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();

    await registration.goto(copiedUrl);
    await expect(registration.getByRole('alert')).toContainText('URL は使えません');
    await expect(register).toHaveCount(0);
  } finally {
    try {
      await recipient.close();
    } finally {
      await executeLocalD1([
        // account_logins から ID を引いてから削除するため、外部キーはバッチの最後に確かめる。
        'PRAGMA defer_foreign_keys = true',
        `DELETE FROM change_logs WHERE organization_id = '${organizationId}'`,
        `DELETE FROM users WHERE organization_id = '${organizationId}'`,
        `DELETE FROM organizations WHERE id = '${organizationId}'`,
        `DELETE FROM sessions WHERE account_id IN (${accountIds})`,
        `DELETE FROM account_consents WHERE account_id IN (${accountIds})`,
        `DELETE FROM accounts WHERE id IN (${accountIds})`,
        `DELETE FROM account_logins WHERE account_id IN (${accountIds})`,
        `DELETE FROM password_credentials WHERE email IN ('${originalEmail}', '${email}')`,
      ]);
    }
  }
});
