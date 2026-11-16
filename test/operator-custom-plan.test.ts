// 個別の契約の受け入れ条件と、値・競合の境界を API の入口で確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  listOrganizations,
  organizationPlanUpdate,
  organizationStorageUpdate,
} from '../src/shared/operations/operator/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { createOrganization } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations);
const GIB = 1024 ** 3;
const terms = {
  plan: 'custom',
  billing_interval: 'yearly',
  custom_member_limit: 80,
  custom_attachment_quota_bytes: 200 * GIB,
} as const;
type Contract = {
  plan: 'custom' | 'business';
  billing_interval: 'yearly';
  extra_10gb_units: number;
  extra_50gb_units: number;
  custom_member_limit: number | null;
  custom_attachment_quota_bytes: number | null;
};
const customContract: Contract = { ...terms, extra_10gb_units: 0, extra_50gb_units: 0 };

async function setup() {
  const organization = await createOrganization({ trial_ends_on: '2099-12-01' });
  const operator = (await withNewSession(await getOperator())).token;
  const response = await post(app, organizationPlanUpdate, {
    token: operator,
    body: { slug: organization.slug, ...terms, expected: null },
  });
  expect(response.status).toBe(200);
  return { organization, operator, response };
}

async function rows(id: string) {
  const db = commonDb(env);
  return {
    organization: await db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', id))),
    contract: await db.first(
      db.statement((q) => q.selectFrom('organization_contracts').selectAll().where('organization_id', '=', id)),
    ),
  };
}

async function change(
  slug: string,
  token: string,
  values: Record<string, unknown>,
  expected: Contract = customContract,
) {
  return post(app, organizationPlanUpdate, { token, body: { slug, ...terms, ...values, expected } });
}

describe('個別の契約', () => {
  test('80人・200GB・年払いを付けると、契約・上限・お試しと運用者一覧に反映する', async () => {
    const { organization, operator, response } = await setup();
    expect(await response.json()).toMatchObject({
      contract: customContract,
      member_limit: 80,
      attachment_quota_bytes: 200 * GIB,
      trial_ends_on: null,
    });
    expect(await rows(organization.id)).toMatchObject({
      organization: { member_limit: 80, attachment_quota_bytes: 200 * GIB, trial_ends_on: null },
      contract: customContract,
    });
    const listed = (await (await post(app, listOrganizations, { token: operator })).json()) as {
      organizations: { slug: string; contract: unknown; seats: unknown; attachment_quota_bytes: number }[];
    };
    expect(listed.organizations.find((row) => row.slug === organization.slug)).toMatchObject({
      contract: customContract,
      seats: { limit: 80 },
      attachment_quota_bytes: 200 * GIB,
    });
  });

  test('管理者に個別の契約と効く上限を返す', async () => {
    const { organization } = await setup();
    const admin = await createPerson({ organization, admin: true });
    const response = await post(app, organizationInfo, {
      token: admin.token,
      slug: organization.slug,
      body: { include_plan: true },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plan: { contract: customContract, member_limit: 80, attachment_quota_bytes: 200 * GIB },
    });
  });

  test('50GBを1口足すと250GBになり、ビジネスへ変えると個別の値を空にして50人・150GBになる', async () => {
    const { organization, operator } = await setup();
    const response = await post(app, organizationStorageUpdate, {
      token: operator,
      body: {
        slug: organization.slug,
        billing_interval: 'yearly',
        extra_10gb_units: 0,
        extra_50gb_units: 1,
        expected: customContract,
      },
    });
    expect(response.status).toBe(200);
    const withStorage = { ...customContract, extra_50gb_units: 1 };
    expect(await response.json()).toMatchObject({
      contract: withStorage,
      member_limit: 80,
      attachment_quota_bytes: 250 * GIB,
    });
    expect(await rows(organization.id)).toMatchObject({ contract: withStorage });
    const business = await change(
      organization.slug,
      operator,
      {
        plan: 'business',
        custom_member_limit: null,
        custom_attachment_quota_bytes: null,
      },
      withStorage,
    );
    expect(business.status).toBe(200);
    expect(await business.json()).toMatchObject({
      contract: {
        plan: 'business',
        custom_member_limit: null,
        custom_attachment_quota_bytes: null,
        extra_50gb_units: 1,
      },
      member_limit: 50,
      attachment_quota_bytes: 150 * GIB,
    });
    expect(await rows(organization.id)).toMatchObject({
      organization: { member_limit: 50, attachment_quota_bytes: 150 * GIB },
      contract: { plan: 'business', custom_member_limit: null, custom_attachment_quota_bytes: null },
    });
  });

  test('プランと周期が同じでも個別の値だけを更新し、履歴に前後の値を残す', async () => {
    const { organization, operator } = await setup();
    const response = await change(organization.slug, operator, {
      custom_member_limit: 90,
      custom_attachment_quota_bytes: 220 * GIB,
    });
    expect(response.status).toBe(200);
    expect(await rows(organization.id)).toMatchObject({
      organization: { member_limit: 90, attachment_quota_bytes: 220 * GIB },
      contract: { custom_member_limit: 90, custom_attachment_quota_bytes: 220 * GIB },
    });
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    const logs = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('changes_json')
          .where('organization_id', '=', organization.id)
          .where('entity_type', '=', 'organization'),
      ),
    );
    const changes = logs.map((log) => JSON.parse(log.changes_json) as Record<string, unknown>);
    expect(changes).toContainEqual(
      expect.objectContaining({
        custom_member_limit: [null, 80],
        custom_attachment_quota_bytes: [null, 200 * GIB],
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        custom_member_limit: [80, 90],
        custom_attachment_quota_bytes: [200 * GIB, 220 * GIB],
      }),
    );
  });

  test('同じ個別の値を再送しても履歴を増やさない', async () => {
    const { organization, operator } = await setup();
    const before = await rows(organization.id);
    expect((await change(organization.slug, operator, {})).status).toBe(200);
    expect(await rows(organization.id)).toEqual(before);
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    const logs = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('id')
          .where('organization_id', '=', organization.id)
          .where('entity_type', '=', 'organization'),
      ),
    );
    expect(logs).toHaveLength(1);
  });

  for (const column of ['custom_member_limit', 'custom_attachment_quota_bytes'] as const) {
    test(`前の契約の${column}だけが違うとプラン変更も追加容量変更も409で書かない`, async () => {
      const { organization, operator } = await setup();
      const before = await rows(organization.id);
      const stale = { ...customContract, [column]: column === 'custom_member_limit' ? 79 : 199 * GIB };
      const plan = await change(organization.slug, operator, { custom_member_limit: 90 }, stale);
      expect(plan.status).toBe(409);
      const storage = await post(app, organizationStorageUpdate, {
        token: operator,
        body: {
          slug: organization.slug,
          billing_interval: 'yearly',
          extra_10gb_units: 0,
          extra_50gb_units: 1,
          expected: stale,
        },
      });
      expect(storage.status).toBe(409);
      expect(await rows(organization.id)).toEqual(before);
    });
  }
});

describe('個別の契約の入力の範囲', () => {
  test.each([
    [1, 1],
    [15, 200],
    [10000, 100 * 1024],
  ])('%i人・%iGBは契約できる（51人未満もよい）', async (members, gib) => {
    const organization = await createOrganization();
    const operator = (await withNewSession(await getOperator())).token;
    const response = await post(app, organizationPlanUpdate, {
      token: operator,
      body: {
        slug: organization.slug,
        ...terms,
        custom_member_limit: members,
        custom_attachment_quota_bytes: gib * GIB,
        expected: null,
      },
    });
    expect(response.status).toBe(200);
    expect(await rows(organization.id)).toMatchObject({
      organization: { member_limit: members, attachment_quota_bytes: gib * GIB },
    });
  });

  test.each([
    ['custom_member_limit', undefined],
    ['custom_member_limit', null],
    ['custom_member_limit', 0],
    ['custom_member_limit', 10001],
    ['custom_member_limit', 1.5],
    ['custom_attachment_quota_bytes', undefined],
    ['custom_attachment_quota_bytes', null],
    ['custom_attachment_quota_bytes', 0],
    ['custom_attachment_quota_bytes', GIB / 2],
    ['custom_attachment_quota_bytes', GIB + 1],
    ['custom_attachment_quota_bytes', 100 * 1024 ** 4 + GIB],
  ])('%s が %s なら400で契約を作らない', async (column, value) => {
    const organization = await createOrganization();
    const operator = (await withNewSession(await getOperator())).token;
    const response = await post(app, organizationPlanUpdate, {
      token: operator,
      body: { slug: organization.slug, ...terms, [column]: value, expected: null },
    });
    expect(response.status).toBe(400);
    expect((await rows(organization.id)).contract).toBeUndefined();
  });

  test.each(['team', 'business'])('%s に個別の値を付けると400で契約を作らない', async (plan) => {
    const organization = await createOrganization();
    const operator = (await withNewSession(await getOperator())).token;
    const response = await post(app, organizationPlanUpdate, {
      token: operator,
      body: { slug: organization.slug, ...terms, plan, expected: null },
    });
    expect(response.status).toBe(400);
    expect((await rows(organization.id)).contract).toBeUndefined();
  });
});
