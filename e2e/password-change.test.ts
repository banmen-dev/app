// 専用のアカウントで、マイプロフィールからの変更と、2台分のセッションの扱いを本物の API で確かめる。
import { randomBytes } from 'node:crypto';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { SEED_PASSWORD_LOGINS } from '../seed/passwords.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { me } from '../src/shared/operations/session/index.ts';
import { PASSWORD_LOGIN_ENABLED } from '../src/shared/password-login-enabled.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { sessionInserts } from '../scripts/seed.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { executeLocalD1 } from './local-d1.ts';

test('パスワードを変えると今の端末は使え、後からログインした別の端末はログインし直す', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL が無い');
  const accountId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const slug = `password-change-${organizationId.slice(-12)}`;
  const settingsPath = `/${slug}/me`;
  const email = `password-change-${accountId}@example.test`;
  const seedLogin = SEED_PASSWORD_LOGINS.single;
  const currentPassword = seedLogin.password;
  const newPassword = 'kawasemi-hanare-2026';
  const now = new Date();
  const older = new Date(now.getTime() - 1_000);
  const at = now.toISOString();
  const current = { accountId, token: randomBytes(32).toString('base64url'), description: '変更する端末' };
  const other = { accountId, token: randomBytes(32).toString('base64url'), description: '変更で失効する端末' };
  const otherContext = await browser.newContext({ baseURL });
  const cookie = (value: string) => ({ name: sessionCookieName(baseURL), value, url: baseURL, httpOnly: true });
  const whoAmI = (device: typeof context) =>
    device.request.post(operationPath(me), { data: {}, headers: { Origin: baseURL } });

  try {
    await executeLocalD1([
      `INSERT INTO accounts (id, created_at, updated_at) VALUES ('${accountId}', '${at}', '${at}')`,
      `INSERT INTO account_logins (login_provider, login_subject, account_id, login_name, created_at, updated_at) ` +
        `VALUES ('password', '${accountId}', '${accountId}', 'つばさ', '${at}', '${at}')`,
      `INSERT INTO account_consents (account_id, terms_version, privacy_version, consented_at) ` +
        `VALUES ('${accountId}', '${TERMS_VERSION}', '${PRIVACY_VERSION}', '${at}')`,
      `INSERT INTO password_credentials (login_subject, email, password_hash, display_name, password_changed_at, created_at, updated_at) ` +
        `SELECT '${accountId}', '${email}', password_hash, 'つばさ', '${at}', '${at}', '${at}' ` +
        `FROM password_credentials WHERE login_subject = '${seedLogin.loginSubject}'`,
      `INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) ` +
        `VALUES ('${organizationId}', '${slug}', 'かわせみ工房', 'github:9000000000000001', '${at}', '${at}')`,
      `INSERT INTO users (id, organization_id, account_id, login_provider, login_subject, name, is_admin, created_at, updated_at) ` +
        `VALUES ('${userId}', '${organizationId}', '${accountId}', 'password', '${accountId}', 'つばさ', 1, '${at}', '${at}')`,
      sessionInserts([current], older),
      sessionInserts([other], now),
    ]);
    await context.addCookies([cookie(current.token)]);
    await otherContext.addCookies([cookie(other.token)]);
    expect((await whoAmI(otherContext)).status()).toBe(200);

    await page.goto(settingsPath);
    const section = page.getByRole('region', { name: 'パスワードを変える', exact: true });
    const currentField = section.getByLabel('現在のパスワード', { exact: true });
    const change = section.getByRole('button', { name: 'パスワードを変える', exact: true });
    await currentField.fill('kawasemi-machigai-2026');
    await section.getByLabel('新しいパスワード', { exact: true }).fill(newPassword);
    await section.getByLabel('新しいパスワード（確認）', { exact: true }).fill(newPassword);
    await change.click();
    await expect(section.getByRole('alert')).toHaveText('現在のパスワードが違います。');
    expect((await whoAmI(otherContext)).status()).toBe(200);

    await currentField.fill(currentPassword);
    await change.click();
    await expect(section.getByRole('status')).toHaveText('パスワードを変えました。');

    // 元の Cookie で使えることを確かめる。別の端末では同じページを開くとログインへ移る。
    expect((await context.cookies()).find(({ name }) => name === sessionCookieName(baseURL))?.value).toBe(
      current.token,
    );
    expect((await whoAmI(context)).status()).toBe(200);
    expect((await whoAmI(otherContext)).status()).toBe(401);

    const otherPage = await otherContext.newPage();
    await otherPage.goto(settingsPath);
    await expect(otherPage).toHaveURL(/\/login\?/);

    // 初版はログインのフォームを閉じている。手段が開いたら、別の端末で変更後のパスワードを使って入り直す。
    if (PASSWORD_LOGIN_ENABLED) {
      await otherPage.getByLabel('メールアドレス', { exact: true }).fill(email);
      const password = otherPage.getByLabel('パスワード', { exact: true });
      const submit = otherPage.getByRole('button', { name: 'メールアドレスでログイン', exact: true });
      await password.fill(currentPassword);
      await submit.click();
      await expect(otherPage.getByRole('alert')).toContainText('メールアドレスかパスワードが違います');
      await password.fill(newPassword);
      await submit.click();
      await expect(otherPage.getByRole('region', { name: 'パスワードを変える', exact: true })).toBeVisible();
      expect(new URL(otherPage.url()).pathname).toBe(settingsPath);
    }
  } finally {
    try {
      await otherContext.close();
    } finally {
      await executeLocalD1([
        `DELETE FROM users WHERE id = '${userId}'`,
        `DELETE FROM organizations WHERE id = '${organizationId}'`,
        `DELETE FROM rate_limits WHERE key = 'operation:password-change:${accountId}'`,
        `DELETE FROM password_credentials WHERE login_subject = '${accountId}'`,
        `DELETE FROM sessions WHERE account_id = '${accountId}'`,
        `DELETE FROM account_consents WHERE account_id = '${accountId}'`,
        `DELETE FROM account_logins WHERE account_id = '${accountId}'`,
        `DELETE FROM accounts WHERE id = '${accountId}'`,
      ]);
    }
  }
});

test('OAuth でログインする人のマイプロフィールにパスワード変更の操作は出ない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/me');
  await expect(page.getByRole('heading', { name: 'マイプロフィール', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'パスワードを変える', exact: true })).toHaveCount(0);
});
