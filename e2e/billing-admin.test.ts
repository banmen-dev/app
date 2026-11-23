// API の認可と競合は Workers の test/billing-admin.test.ts、ここでは専用画面の交代フローを確認する。
import { expect, test } from './fixtures.ts';
import { findA11yViolations, findTargetSizeViolations, signIn } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';
import {
  billingAdminInvite,
  billingAdminList,
  billingAdminRemove,
  billingInvitationRespond,
  billingOrganizationSummary,
  myBillingOrganizations,
  operatorBillingAdminInvite,
} from '../src/shared/operations/billing.ts';
import { formatDateTime } from '../src/lib/format-datetime.ts';
import { word as t } from '../src/shared/vocabulary.ts';

const accountId = '019aa222-1111-7000-8000-000000000001';
const nextId = '019aa222-1111-7000-8000-000000000002';
const nominationId = '019aa222-1111-7000-8000-000000000003';
const organization = { slug: 'aoba', name: '青葉工房' };
// 担当組織の一覧の行（#1241）。プランと利用の状態の印が付く
const listed = { ...organization, kind: 'team' as const, plan: 'team' as const, state: 'active' as const };
// 選んだ組織の契約と使用量。担当者の画面を開くテストはすべてこの値で読む
const summary = {
  kind: 'team' as const,
  state: 'active' as const,
  purge_on: null,
  purge_due: false,
  trial_ends_on: null,
  contract: {
    plan: 'team' as const,
    billing_interval: 'yearly' as const,
    extra_10gb_units: 2,
    extra_50gb_units: 0,
    custom_member_limit: null,
    custom_attachment_quota_bytes: null,
  },
  member_limit: 15,
  attachment_quota_bytes: 50 * 1024 ** 3,
  usage: { seats_used: 12, attachment_used_bytes: Math.round(38.25 * 1024 ** 3) },
};
// 一覧の行の名前は、組織名にプランと利用の状態の印を続けたもの
const organizationLink = new RegExp(`^${organization.name} `);

test.beforeEach(async ({ page }) => {
  await mockOperation(page, billingOrganizationSummary, summary);
});

test('請求専用画面で本人承諾・指名・解除・履歴と失敗を確認できる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let accepted = false;
  let invited = false;
  const own = { id: accountId, account_id: accountId, name: '星野 澪', status: 'active' as const };
  const next = { id: nominationId, account_id: nextId, name: '若葉 凪', status: 'pending' as const };
  await routeOperation(page, myBillingOrganizations, async (call) =>
    call.fulfill({
      account_id: accountId,
      operator: false,
      organizations: accepted ? [listed] : [],
      invitations: accepted ? [] : [{ ...organization, id: nominationId }],
    }),
  );
  await routeOperation(page, billingInvitationRespond, async (call) => {
    expect(call.input).toEqual({ invitation_id: nominationId, accept: true });
    accepted = true;
    await call.fulfill({});
  });
  await routeOperation(page, billingAdminList, async (call) => {
    expect(call.input.slug).toBe('aoba');
    await call.fulfill({ administrators: invited ? [own, next] : [own], events: [] });
  });
  await routeOperation(page, billingAdminInvite, async (call) => {
    expect(call.input).toEqual({ slug: 'aoba', account_id: nextId });
    invited = true;
    await call.fulfill({ id: nominationId });
  });
  await routeOperation(page, billingAdminRemove, async (call) => {
    expect(call.input).toEqual({ slug: 'aoba', administrator_id: nominationId });
    invited = false;
    await call.fulfill({});
  });
  await page.goto('/auth/billing');
  await expect(page.getByLabel(t('billingAccountId'))).toHaveValue(accountId);
  await expect(page.getByText(t('billingEmpty'))).toBeVisible();
  await page
    .getByRole('button', {
      name: t('billingAcceptFor', { name: `${organization.name}（${organization.slug}）` }),
      exact: true,
    })
    .click();
  await expect(page.locator('#billing-status-invitations')).toHaveText(t('billingSaved'));
  await expect(page.locator('#billing-status-invitations')).toBeFocused();
  await page.getByRole('link', { name: organizationLink }).click();
  await expect(
    page.getByRole('heading', { name: t('billingAdministrators', { name: organization.name }) }),
  ).toBeVisible();
  await expect(page.getByText(t('billingSaved'), { exact: true })).toHaveCount(0);
  await page.getByLabel(t('billingTargetAccount')).fill(nextId);
  await expect(page.getByLabel(t('billingTargetAccount'))).toHaveAttribute('aria-describedby', 'billing-status-invite');
  await page.getByRole('button', { name: t('billingInvite'), exact: true }).click();
  const row = page.locator('.choice').filter({ hasText: '若葉 凪' });
  await expect(row).toContainText(t('billingPending'));
  await expect(page.getByLabel(t('billingTargetAccount'))).toHaveValue('');
  await expect(page.locator('#billing-status-invite')).toHaveText(t('billingSaved'));
  await row.getByRole('button', { name: t('billingRemove') }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('billingRemove'), exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('#billing-status-administrators')).toHaveText(t('billingSaved'));
  await expect(page.locator('#billing-status-administrators')).toBeFocused();
  await expect(page.getByRole('heading', { name: t('billingHistory') })).toBeVisible();
  await expect(page.getByText(t('billingHistoryEmpty'), { exact: true })).toBeVisible();
  await failOperation(page, billingAdminRemove, 409, 'conflict');
  await page
    .getByRole('button', { name: t('billingRemoveFor', { name: `星野 澪（${accountId}）` }), exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('billingRemove'), exact: true })
    .click();
  await expect(page.getByText(t('billingFailed'), { exact: true })).toBeVisible();
  await expect(page.locator('#billing-status-administrators')).toBeFocused();
  await expect(page.getByText('星野 澪', { exact: true })).toBeVisible();
});

test('運用者の初回指名フォームは組織とアカウントを指定し、一般アカウントには出ない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: true,
    organizations: [],
    invitations: [],
  });
  let calls = 0;
  await routeOperation(page, operatorBillingAdminInvite, async (call) => {
    calls++;
    expect(call.input).toEqual({ slug: 'aoba', account_id: nextId });
    await call.fulfill({ id: nominationId });
  });
  await page.goto('/auth/billing');
  await page.getByLabel(t('billingSlug')).fill('aoba');
  await page.getByLabel(t('billingTargetAccount')).fill(nextId);
  await page.getByRole('button', { name: t('billingInvite'), exact: true }).click();
  await expect(page.getByText(t('billingSaved'), { exact: true })).toBeVisible();
  expect(calls).toBe(1);
  await expect(page.getByLabel(t('billingSlug'))).toHaveValue('');
  await expect(page.getByLabel(t('billingTargetAccount'))).toHaveValue('');
  await expect(page.locator('#billing-status-bootstrap')).toHaveText(t('billingSaved'));
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: false,
    organizations: [],
    invitations: [],
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: t('billingBootstrap') })).toHaveCount(0);
});

for (const width of [390, 1280]) {
  test(`請求管理者の画面は ${width}px で読み上げと横幅を保つ`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.setViewportSize({ width, height: 900 });
    await mockOperation(page, myBillingOrganizations, {
      account_id: accountId,
      operator: false,
      organizations: [listed],
      invitations: [],
    });
    await mockOperation(page, billingAdminList, {
      administrators: [{ id: accountId, account_id: accountId, name: '星野 澪', status: 'active' }],
      events: [
        {
          id: nominationId,
          actor_account_id: accountId,
          target_account_id: nextId,
          actor_name: '星野 澪',
          target_name: '若葉 凪',
          action: 'invited',
          created_at: '2026-11-15T00:00:00.000Z',
        },
      ],
    });
    await page.goto('/auth/billing?organization=aoba');
    await expect(page.getByRole('heading', { name: t('billingHistory') })).toBeVisible();
    expect(await findA11yViolations(page)).toEqual([]);
    if (width <= 760) expect(await findTargetSizeViolations(page)).toEqual([]);
    const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expect(page.getByText(formatDateTime('2026-11-15T00:00:00.000Z', timeZone), { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByText(`${t('billingTarget')}: 若葉 凪`, { exact: true })).toBeVisible();
    await mockOperation(page, myBillingOrganizations, {
      account_id: accountId,
      operator: true,
      organizations: [],
      invitations: [
        { ...organization, id: nominationId },
        { slug: 'wakaba', name: '若葉商会', id: nextId },
      ],
    });
    await page.goto('/auth/billing');
    await expect(page.getByRole('heading', { name: t('billingBootstrap') })).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: t('billingAcceptFor', { name: `${organization.name}（${organization.slug}）` }),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('billingDeclineFor', { name: '若葉商会（wakaba）' }), exact: true }),
    ).toBeVisible();
    expect(await findA11yViolations(page)).toEqual([]);
    if (width <= 760) expect(await findTargetSizeViolations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('担当組織の一覧にプランと利用の状態を出し、選ぶと契約と使用量を上限と並べて出す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: false,
    organizations: [
      listed,
      { slug: 'fujino', name: '藤野工房', kind: 'team', plan: null, state: 'suspended' },
      { slug: 'kaede', name: '楓工房', kind: 'team', plan: 'small', state: 'cancelled' },
    ],
    invitations: [],
  });
  await mockOperation(page, billingAdminList, { administrators: [], events: [] });
  await page.goto('/auth/billing');
  const rows = page.locator('.choice-list a.choice');
  await expect(rows.filter({ hasText: organization.name })).toContainText(`${t('planTeam')}${t('billingStateActive')}`);
  await expect(rows.filter({ hasText: '藤野工房' })).toContainText(
    `${t('operatorPlanNone')}${t('billingStateSuspended')}`,
  );
  await expect(rows.filter({ hasText: '楓工房' })).toContainText(`${t('planSmall')}${t('billingStateCancelled')}`);

  await page.getByRole('link', { name: organizationLink }).click();
  const sheet = page.locator('section').filter({
    has: page.getByRole('heading', { name: t('billingSummary', { name: organization.name }) }),
  });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(t('planTerms', { plan: t('planTeam'), interval: t('billingYearly') }));
  await expect(sheet).toContainText(t('orgPlanExtraUnits', { size: 10, units: '2' }));
  await expect(sheet).toContainText(t('billingUsageSeats', { used: '12', limit: '15' }));
  await expect(sheet).toContainText(
    t('billingUsageStorage', {
      used: t('operatorQuotaSize', { size: '38.2' }),
      quota: t('operatorQuotaSize', { size: '50' }),
    }),
  );
  await expect(sheet).toContainText(t('orgPlanContact'));
  // 契約と使用量の紙は担当者の紙より前に並ぶ
  const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
  expect(headings.indexOf(t('billingSummary', { name: organization.name }))).toBeLessThan(
    headings.indexOf(t('billingAdministrators', { name: organization.name })),
  );
});

test('解約で停止した未契約の組織は、消す予定日と未契約の案内を出す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: false,
    organizations: [{ ...listed, plan: null, state: 'cancelled' }],
    invitations: [],
  });
  await mockOperation(page, billingAdminList, { administrators: [], events: [] });
  await mockOperation(page, billingOrganizationSummary, {
    ...summary,
    state: 'cancelled',
    purge_on: '2026-12-15',
    purge_due: true,
    contract: null,
  });
  await page.goto('/auth/billing?organization=aoba');
  await expect(page.getByText(t('billingStateCancelled'), { exact: true })).toBeVisible();
  await expect(page.getByText(t('billingPurgeDue', { date: '2026-12-15' }), { exact: true })).toBeVisible();
  await expect(page.getByText(t('orgPlanNoneNote'), { exact: true })).toBeVisible();
  await expect(page.getByText(t('orgPlanExtraLabel'), { exact: true })).toHaveCount(0);
});

test('契約と使用量だけが読めなくても、担当者の管理は使える', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: false,
    organizations: [listed],
    invitations: [],
  });
  await mockOperation(page, billingAdminList, {
    administrators: [{ id: accountId, account_id: accountId, name: '星野 澪', status: 'active' }],
    events: [],
  });
  await failOperation(page, billingOrganizationSummary, 500, 'internal');
  await page.goto('/auth/billing?organization=aoba');
  await expect(page.getByText(t('billingSummaryLoadFailed'), { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: t('billingAdministrators', { name: organization.name }) }),
  ).toBeVisible();
  await expect(page.getByText('星野 澪', { exact: true })).toBeVisible();
  await mockOperation(page, billingOrganizationSummary, summary);
  await page.getByRole('button', { name: t('retry'), exact: true }).click();
  await expect(page.getByText(t('billingSummaryLoadFailed'), { exact: true })).toHaveCount(0);
  await expect(page.getByText(t('billingUsageSeats', { used: '12', limit: '15' }), { exact: true })).toBeVisible();
});

test('未ログインでは請求の専用画面からログインへ戻る', async ({ page }) => {
  await page.goto('/auth/billing');
  await expect(page).toHaveURL(/\/login\?return_to=%2Fauth%2Fbilling/);
});

test('指名の保存後に一覧を読み込めなくても保存済みと伝える', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: true,
    organizations: [],
    invitations: [],
  });
  await routeOperation(page, operatorBillingAdminInvite, async (call) => {
    await failOperation(page, myBillingOrganizations, 500, 'internal');
    await call.fulfill({ id: nominationId });
  });
  await page.goto('/auth/billing');
  await page.getByLabel(t('billingSlug')).fill('aoba');
  await page.getByLabel(t('billingTargetAccount')).fill(nextId);
  await page.getByRole('button', { name: t('billingInvite'), exact: true }).click();
  await expect(page.getByText(t('billingRefreshFailed'), { exact: true })).toBeVisible();
});

test('指名に失敗した後の読込失敗を保存済みと案内しない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: true,
    organizations: [listed],
    invitations: [],
  });
  await failOperation(page, operatorBillingAdminInvite, 409, 'conflict');
  await failOperation(page, billingAdminList, 500, 'internal');
  await page.goto('/auth/billing');
  await page.getByLabel(t('billingSlug')).fill('aoba');
  await page.getByLabel(t('billingTargetAccount')).fill(nextId);
  await page.getByRole('button', { name: t('billingInvite'), exact: true }).click();
  await expect(page.getByText(t('billingFailed'), { exact: true })).toBeVisible();
  await page.getByRole('link', { name: organizationLink }).click();
  await expect(page.getByRole('heading', { name: t('loadFailedTitle') })).toBeVisible();
  await expect(page.getByText(t('billingRefreshFailed'), { exact: true })).toHaveCount(0);
});

test('送信中に書いた次の指名先を成功時に消さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, myBillingOrganizations, {
    account_id: accountId,
    operator: false,
    organizations: [listed],
    invitations: [],
  });
  await mockOperation(page, billingAdminList, {
    administrators: [{ id: accountId, account_id: accountId, name: '星野 澪', status: 'active' }],
    events: [],
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, billingAdminInvite, async (call) => {
    expect(call.input.account_id).toBe(nextId);
    await pending;
    await call.fulfill({ id: nominationId });
  });
  await page.goto('/auth/billing?organization=aoba');
  await page.getByLabel(t('billingTargetAccount')).fill(nextId);
  await page.getByRole('button', { name: t('billingInvite'), exact: true }).click();
  await expect(page.locator('#billing-status-invite')).toHaveText(t('billingBusy'));
  const draft = '019aa222-1111-7000-8000-000000000004';
  await page.getByLabel(t('billingTargetAccount')).fill(draft);
  await expect(page.getByRole('button', { name: t('billingInvite'), exact: true })).toBeDisabled();
  await page.getByLabel(t('billingTargetAccount')).press('Enter');
  await expect(page.locator('#billing-status-invite')).toHaveText(t('billingBusy'));
  release();
  await expect(page.locator('#billing-status-invite')).toHaveText(t('billingSaved'));
  await expect(page.getByLabel(t('billingTargetAccount'))).toHaveValue(draft);
});

for (const accept of [true, false]) {
  for (const moveFocus of [true, false]) {
    test(`指名の応答失敗 accept=${accept} は通知を読み上げ、別欄へ移ったフォーカスを奪わない move=${moveFocus}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await signIn(context, baseURL, 'admin');
      await mockOperation(page, myBillingOrganizations, {
        account_id: accountId,
        operator: false,
        organizations: [],
        invitations: [{ ...organization, id: nominationId }],
      });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await routeOperation(page, billingInvitationRespond, async (call) => {
        await pending;
        await call.fail(409, 'conflict');
      });
      await page.goto('/auth/billing');
      await page
        .getByRole('button', {
          name: t(accept ? 'billingAcceptFor' : 'billingDeclineFor', {
            name: `${organization.name}（${organization.slug}）`,
          }),
          exact: true,
        })
        .click();
      await expect(page.locator('#billing-status-invitations')).toHaveText(t('billingBusy'));
      if (moveFocus) await page.getByLabel(t('billingAccountId')).focus();
      else await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      release();
      await expect(page.locator('#billing-status-invitations')).toHaveText(t('billingFailed'));
      if (moveFocus) await expect(page.getByLabel(t('billingAccountId'))).toBeFocused();
      else await expect(page.locator('#billing-status-invitations')).toBeFocused();
      await expect(
        page.getByRole('button', {
          name: t('billingAcceptFor', { name: `${organization.name}（${organization.slug}）` }),
          exact: true,
        }),
      ).toBeVisible();
    });
  }
}

for (const navigate of [false, true]) {
  test(`初回指名の送信中の入力と画面移動を保持する navigate=${navigate}`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let reads = 0;
    await routeOperation(page, myBillingOrganizations, async (call) => {
      reads++;
      await call.fulfill({ account_id: accountId, operator: true, organizations: [listed], invitations: [] });
    });
    await mockOperation(page, billingAdminList, {
      administrators: [{ id: accountId, account_id: accountId, name: '星野 澪', status: 'active' }],
      events: [],
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await routeOperation(page, operatorBillingAdminInvite, async (call) => {
      await pending;
      await call.fulfill({ id: nominationId });
    });
    await page.goto('/auth/billing');
    await page.getByLabel(t('billingSlug')).fill('aoba');
    await page.getByLabel(t('billingTargetAccount')).fill(nextId);
    await page.getByRole('button', { name: t('billingInvite'), exact: true }).click();
    await expect(page.locator('#billing-status-bootstrap')).toHaveText(t('billingBusy'));
    if (navigate) {
      await page.getByRole('link', { name: organizationLink }).click();
      await expect(page.getByRole('heading', { name: t('billingHistory') })).toBeVisible();
      const before = reads;
      release();
      await expect.poll(() => reads).toBeGreaterThan(before);
      await expect(page.getByText(t('billingSaved'), { exact: true })).toHaveCount(0);
    } else {
      await page.getByLabel(t('billingSlug')).fill('wakaba');
      await page.getByLabel(t('billingTargetAccount')).fill(accountId);
      release();
      await expect(page.locator('#billing-status-bootstrap')).toHaveText(t('billingSaved'));
      await expect(page.getByLabel(t('billingSlug'))).toHaveValue('wakaba');
      await expect(page.getByLabel(t('billingTargetAccount'))).toHaveValue(accountId);
    }
    expect(errors).toEqual([]);
  });
}
