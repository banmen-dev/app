// #1241 担当組織の契約と使用量（billing-organization-summary）を、test/billing-organization-summary.test.ts と
// test/billing-organization-summary-breakers.test.ts に無い手口で崩しにかかる（2周目）。
// 見るのは、大きな値（人数の上限 10,000、容量 100 TB、32 ビットを超える使用量、大きな追加容量の口数）が丸められず整数のまま返ること、
// 入力の形が違うときに 404 でも 500 でもなく 400 で断り、担当外の人にも同じ形で答えること、操作の定義の属性
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { billingOrganizationSummary, myBillingOrganizations } from '../src/shared/operations/billing.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import {
  AT,
  createAttachment,
  createOrganization,
  createWorkspace,
  uuidv7,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
const TIB = 1024 ** 4;
const MAX_FILE = 52_428_800;

type Summary = OutputOf<typeof billingOrganizationSummary>;

async function makeActive(organization: OrganizationFixture, person: Person) {
  const invitedBy = (await getOperator()).accountId;
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('billing_administrators').values({
        id: uuidv7(),
        organization_id: organization.id,
        account_id: person.accountId,
        status: 'active',
        invited_by: invitedBy,
        is_bootstrap: 1,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
}
async function summaryOf(person: Person, slug: string): Promise<Summary> {
  const response = await post(app, billingOrganizationSummary, { token: person.token, body: { slug } });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

describe('大きな値', () => {
  test('人数の上限 10,000・容量 100 TB の個別契約と、32 ビットを超える使用量を、丸めず整数のまま返す', async () => {
    const organization = await createOrganization({ member_limit: 10_000, attachment_quota_bytes: 100 * TIB });
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.insertInto('organization_contracts').values({
          organization_id: organization.id,
          plan: 'custom',
          billing_interval: 'yearly',
          extra_10gb_units: 1_000,
          extra_50gb_units: 2_000,
          custom_member_limit: 10_000,
          custom_attachment_quota_bytes: 100 * TIB,
          created_at: AT,
          updated_at: AT,
        }),
      ),
    ]);
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    // 添付1件の上限（50 MiB）で 100 件と 1 バイト。合計は 2^32 を超える
    for (let index = 0; index < 100; index++) {
      await createAttachment(organization, workspace.id, admin.userId!, { size_bytes: MAX_FILE });
    }
    await createAttachment(organization, workspace.id, admin.userId!, { size_bytes: 1 });
    const billing = await createPerson();
    await makeActive(organization, billing);

    const result = await summaryOf(billing, organization.slug);
    expect(result.member_limit).toBe(10_000);
    expect(result.attachment_quota_bytes).toBe(100 * TIB);
    expect(result.contract).toEqual({
      plan: 'custom',
      billing_interval: 'yearly',
      extra_10gb_units: 1_000,
      extra_50gb_units: 2_000,
      custom_member_limit: 10_000,
      custom_attachment_quota_bytes: 100 * TIB,
    });
    expect(result.usage.attachment_used_bytes).toBe(100 * MAX_FILE + 1);
    expect(result.usage.attachment_used_bytes).toBeGreaterThan(2 ** 32);
    expect(Number.isSafeInteger(result.usage.attachment_used_bytes)).toBe(true);
    expect(result.usage.seats_used).toBe(1);
  });

  test('一覧の行も、大きな上限の組織で同じプランと状態を返す', async () => {
    const organization = await createOrganization({ member_limit: 10_000, attachment_quota_bytes: 100 * TIB });
    const billing = await createPerson();
    await makeActive(organization, billing);
    const response = await post(app, myBillingOrganizations, { token: billing.token, body: {} });
    expect(response.status).toBe(200);
    const list = (await response.json()) as OutputOf<typeof myBillingOrganizations>;
    expect(list.organizations).toEqual([
      { slug: organization.slug, name: organization.name, kind: 'team', plan: null, state: 'active' },
    ]);
  });

  test('使用量が上限を超えていても、上限で切らずにそのままの合計を返す', async () => {
    const organization = await createOrganization({ member_limit: 1, attachment_quota_bytes: 64 * 1024 ** 2 });
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    // 上限を下げる前に入っていたメンバー（上限を超えた2人目）
    await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    await createAttachment(organization, workspace.id, admin.userId!, { size_bytes: MAX_FILE });
    await createAttachment(organization, workspace.id, admin.userId!, { size_bytes: MAX_FILE });
    const billing = await createPerson();
    await makeActive(organization, billing);
    const result = await summaryOf(billing, organization.slug);
    expect(result.usage).toEqual({ seats_used: 2, attachment_used_bytes: 2 * MAX_FILE });
  });
});

describe('入力の形', () => {
  test.each([
    ['slug が無い', {}],
    ['slug が数', { slug: 1 }],
    ['slug が null', { slug: null }],
    ['slug が空', { slug: '' }],
    ['slug が 64 文字', { slug: 'a'.repeat(64) }],
    ['slug が配列', { slug: ['x'] }],
  ])('%s: 承諾済みの担当者にも 400 の invalid_input（404 や 500 にしない）', async (_name, body) => {
    const organization = await createOrganization();
    const billing = await createPerson();
    await makeActive(organization, billing);
    const response = await post(app, billingOrganizationSummary, { token: billing.token, body });
    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('invalid_input');
  });

  test('壊れた JSON は 400 で、担当者でも第三者でも同じ', async () => {
    const organization = await createOrganization();
    const billing = await createPerson();
    await makeActive(organization, billing);
    const stranger = await createPerson();
    for (const person of [billing, stranger]) {
      const response = await post(app, billingOrganizationSummary, { token: person.token, rawBody: '{"slug":' });
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
    }
  });

  test('63 文字ちょうどの存在しない slug は 404（上限の内側は形の検査を通る）', async () => {
    const billing = await createPerson();
    const response = await post(app, billingOrganizationSummary, {
      token: billing.token,
      body: { slug: 'a'.repeat(63) },
    });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
  });

  test('余分な鍵（organization_id など）を足しても、担当外の組織は 404 のまま', async () => {
    const organization = await createOrganization();
    const other = await createOrganization();
    const billing = await createPerson();
    await makeActive(other, billing);
    const response = await post(app, billingOrganizationSummary, {
      token: billing.token,
      body: { slug: organization.slug, organization_id: other.id, account_id: billing.accountId },
    });
    expect([400, 404]).toContain(response.status);
    expect(await response.clone().text()).not.toContain('member_limit');
  });
});

test('操作の定義: ログインだけの read、Cookie 専用、1分に30回の上限（Issue の「読み取りの操作」「cookieOnly」）', () => {
  const definition = billingOrganizationSummary as typeof billingOrganizationSummary & {
    rateLimit?: unknown;
    cookieOnly?: true;
    body?: unknown;
    response?: unknown;
  };
  expect(definition.name).toBe('billing-organization-summary');
  expect(definition.mode).toBe('read');
  expect(definition.permission).toBe('login');
  expect(definition.cookieOnly).toBe(true);
  // レビューで回数の上限を付けた（開くたびに組織全体を数えるため。Wiki の検索と同じ枠）
  expect(definition.rateLimit).toEqual({ max: 30, windowSeconds: 60 });
  expect(definition.body).toBeUndefined();
  expect(definition.response).toBeUndefined();
  expect(implementedOperations.some((operation) => operation.definition.name === definition.name)).toBe(true);
});
