// 個別契約の読取後の競合と、履歴APIへの変換を独立した入力で確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { organizationPlanUpdate, organizationStorageUpdate } from '../src/shared/operations/operator/index.ts';
import { organizationHistory } from '../src/shared/operations/organization/organization-history.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { createOrganization } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, testEnv, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations);
const GIB = 1024 ** 3;
type Contract = OutputOf<typeof organizationPlanUpdate>['contract'];
async function setup() {
  const organization = await createOrganization();
  const operator = (await withNewSession(await getOperator())).token;
  const response = await post(app, organizationPlanUpdate, {
    token: operator,
    body: {
      slug: organization.slug,
      plan: 'custom',
      billing_interval: 'monthly',
      custom_member_limit: 73,
      custom_attachment_quota_bytes: 183 * GIB,
      expected: null,
    },
  });
  expect(response.status).toBe(200);
  const { contract } = (await response.json()) as OutputOf<typeof organizationPlanUpdate>;
  return { organization, operator, contract };
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
function planBody(slug: string, expected: Contract) {
  return { slug, plan: 'business', billing_interval: 'yearly', expected };
}
function storageBody(slug: string, expected: Contract) {
  return { slug, billing_interval: 'monthly', extra_10gb_units: 2, extra_50gb_units: 1, expected };
}

describe('個別契約の独立した反証ケース', () => {
  for (const key of ['custom_member_limit', 'custom_attachment_quota_bytes'] as const) {
    for (const operation of [organizationPlanUpdate, organizationStorageUpdate]) {
      test(`${operation.name}: 読取後に${key}だけが変われば上限も履歴も上書きしない`, async () => {
        const { organization, operator, contract } = await setup();
        const before = await rows(organization.id);
        const changed = key === 'custom_member_limit' ? 74 : 184 * GIB;
        let armed = true;
        const racing = envWithD1Hooks(testEnv, {
          afterQuery: async (sql) => {
            if (!armed || !sql.includes('"organization_contracts"') || !sql.includes('"trial_ends_on"')) return;
            armed = false;
            const db = commonDb(env);
            await db.batch([
              db.statement((q) =>
                q
                  .updateTable('organization_contracts')
                  .set({ [key]: changed })
                  .where('organization_id', '=', organization.id),
              ),
            ]);
          },
        });
        const response = await post(app, operation, {
          token: operator,
          env: racing,
          body:
            operation.name === organizationPlanUpdate.name
              ? planBody(organization.slug, contract)
              : storageBody(organization.slug, contract),
        });
        expect(armed).toBe(false);
        expect(response.status).toBe(409);
        expect(await rows(organization.id)).toEqual({
          organization: before.organization,
          contract: { ...before.contract, [key]: changed },
        });
        const admin = await createPerson({ organization, admin: true });
        const history = await post(app, organizationHistory, { slug: organization.slug, token: admin.token });
        expect(history.status).toBe(200);
        expect(((await history.json()) as OutputOf<typeof organizationHistory>).entries).toHaveLength(1);
      });
    }
  }

  test('旧expectedで個別値を省略しても、個別の契約を通常プランや追加容量で上書きしない', async () => {
    const { organization, operator, contract } = await setup();
    const oldExpected = {
      plan: contract.plan,
      billing_interval: contract.billing_interval,
      extra_10gb_units: 0,
      extra_50gb_units: 0,
    };
    const before = await rows(organization.id);
    expect(
      (
        await post(app, organizationPlanUpdate, {
          token: operator,
          body: { ...planBody(organization.slug, contract), expected: oldExpected },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(app, organizationStorageUpdate, {
          token: operator,
          body: { ...storageBody(organization.slug, contract), expected: oldExpected },
        })
      ).status,
    ).toBe(409);
    expect(await rows(organization.id)).toEqual(before);
  });

  test('履歴APIで個別値の変更と通常プランへの復帰を前後の値で返す', async () => {
    const { organization, operator, contract } = await setup();
    const custom = { ...contract, custom_member_limit: 37, custom_attachment_quota_bytes: 281 * GIB };
    const changed = await post(app, organizationPlanUpdate, {
      token: operator,
      body: { slug: organization.slug, ...custom, expected: contract },
    });
    expect(changed.status).toBe(200);
    expect(
      (await post(app, organizationPlanUpdate, { token: operator, body: planBody(organization.slug, custom) })).status,
    ).toBe(200);
    const admin = await createPerson({ organization, admin: true });
    const response = await post(app, organizationHistory, { token: admin.token, slug: organization.slug });
    expect(response.status).toBe(200);
    const { entries } = (await response.json()) as OutputOf<typeof organizationHistory>;
    expect(entries.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        {
          kind: 'organization_plan_changed',
          from: null,
          to: {
            plan: 'custom',
            billing_interval: 'monthly',
            custom_member_limit: 73,
            custom_attachment_quota_bytes: 183 * GIB,
          },
        },
        {
          kind: 'organization_plan_changed',
          from: {
            plan: 'custom',
            billing_interval: 'monthly',
            custom_member_limit: 73,
            custom_attachment_quota_bytes: 183 * GIB,
          },
          to: {
            plan: 'custom',
            billing_interval: 'monthly',
            custom_member_limit: 37,
            custom_attachment_quota_bytes: 281 * GIB,
          },
        },
        {
          kind: 'organization_plan_changed',
          from: {
            plan: 'custom',
            billing_interval: 'monthly',
            custom_member_limit: 37,
            custom_attachment_quota_bytes: 281 * GIB,
          },
          to: {
            plan: 'business',
            billing_interval: 'yearly',
            custom_member_limit: null,
            custom_attachment_quota_bytes: null,
          },
        },
      ]),
    );
  });

  test('書込後に応答が失われても個別値の再送は成功し上限を変え直さない', async () => {
    const { organization, operator, contract } = await setup();
    let armed = true;
    const lost = envWithD1Hooks(testEnv, {
      afterBatch: (sqls) => {
        if (!armed || !sqls.some((sql) => sql.startsWith('update "organization_contracts"'))) return;
        armed = false;
        throw new Error('simulated response loss');
      },
    });
    const body = {
      slug: organization.slug,
      plan: 'custom',
      billing_interval: 'monthly',
      custom_member_limit: 42,
      custom_attachment_quota_bytes: 211 * GIB,
      expected: contract,
    };
    expect((await post(app, organizationPlanUpdate, { token: operator, body, env: lost })).status).toBe(500);
    const before = await rows(organization.id);
    const retried = await post(app, organizationPlanUpdate, { token: operator, body });
    expect(retried.status).toBe(200);
    expect(await rows(organization.id)).toEqual(before);
    expect(before.organization).toMatchObject({ member_limit: 42, attachment_quota_bytes: 211 * GIB });
  });
});
