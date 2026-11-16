// 初回指名の出所が、運用者と請求管理者の兼任によって変わらないことを確認する。
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  billingAdminInvite,
  billingAdminList,
  billingInvitationRespond,
  myBillingOrganizations,
  operatorBillingAdminInvite,
} from '../src/shared/operations/billing.ts';
import type { AnyOperationDefinition, OutputOf } from '../src/shared/operations/define.ts';
import { createOrganization } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
async function ok<D extends AnyOperationDefinition>(
  person: Person,
  definition: D,
  body: unknown = {},
): Promise<OutputOf<D>> {
  const response = await post(app, definition, { token: person.token, body });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

test('運用者自身が最初の請求担当者になっても残りの初回指名は失効し通常の再指名が必要', async () => {
  const organization = await createOrganization();
  const operator = await getOperator();
  const second = await createPerson();
  const self = await ok(operator, operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: operator.accountId,
  });
  const old = await ok(operator, operatorBillingAdminInvite, { slug: organization.slug, account_id: second.accountId });
  await ok(operator, billingInvitationRespond, { invitation_id: self.id, accept: true });
  expect((await ok(second, myBillingOrganizations)).invitations).toEqual([]);
  for (const accept of [true, false]) {
    const response = await post(app, billingInvitationRespond, {
      token: second.token,
      body: { invitation_id: old.id, accept },
    });
    expect(response.status).toBe(404);
  }
  const fresh = await ok(operator, billingAdminInvite, { slug: organization.slug, account_id: second.accountId });
  expect(fresh.id).not.toBe(old.id);
  await ok(second, billingInvitationRespond, { invitation_id: fresh.id, accept: true });
  expect(
    (await ok(operator, billingAdminList, { slug: organization.slug })).administrators.filter(
      (row) => row.status === 'active',
    ),
  ).toHaveLength(2);
});
