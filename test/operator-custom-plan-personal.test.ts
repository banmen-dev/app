import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { organizationStorageUpdate } from '../src/shared/operations/operator/index.ts';
import { AT, createOrganization } from './factories.ts';
import { post } from './operations/harness.ts';
import { getOperator, withNewSession } from './operations/world.ts';

const GIB = 1024 ** 3;

test('自分用の組織の個別契約は追加容量操作で書き換えず409を返す', async () => {
  const organization = await createOrganization({
    kind: 'personal',
    member_limit: 1,
    attachment_quota_bytes: 200 * GIB,
  });
  const contract = {
    plan: 'custom' as const,
    billing_interval: 'yearly' as const,
    custom_member_limit: 1,
    custom_attachment_quota_bytes: 200 * GIB,
    extra_10gb_units: 0,
    extra_50gb_units: 0,
  };
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('organization_contracts').values({
        organization_id: organization.id,
        ...contract,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
  const rows = async () => ({
    organization: await db.first(
      db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', organization.id)),
    ),
    contract: await db.first(
      db.statement((q) =>
        q.selectFrom('organization_contracts').selectAll().where('organization_id', '=', organization.id),
      ),
    ),
  });
  const before = await rows();
  const { token } = await withNewSession(await getOperator());
  const response = await post(createApp(implementedOperations), organizationStorageUpdate, {
    token,
    body: {
      slug: organization.slug,
      billing_interval: 'yearly',
      extra_10gb_units: 0,
      extra_50gb_units: 1,
      expected: contract,
    },
  });
  expect(response.status).toBe(409);
  expect(await rows()).toEqual(before);
});
