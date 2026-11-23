// 初回指名は最初の担当者が承諾した時点で失効し、担当者が後でゼロになっても復活しない。
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  billingAdminRemove,
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
  expect(response.status, `${definition.name}: ${await response.clone().text()}`).toBe(200);
  return response.json();
}

test('初回承諾後に残った指名は全担当者の解除後も復活せず、再指名には新しいIDが必要', async () => {
  const organization = await createOrganization();
  const first = await createPerson();
  const second = await createPerson();
  const operator = await getOperator();
  const firstInvitation = await ok(operator, operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: first.accountId,
  });
  const staleInvitation = await ok(operator, operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: second.accountId,
  });
  expect((await ok(second, myBillingOrganizations)).invitations).toContainEqual(
    expect.objectContaining({ id: staleInvitation.id }),
  );
  await ok(first, billingInvitationRespond, { invitation_id: firstInvitation.id, accept: true });
  expect((await ok(second, myBillingOrganizations)).invitations).toEqual([]);

  // 未契約なので、最後の担当者も自分の権限を解除できる。
  await ok(first, billingAdminRemove, {
    slug: organization.slug,
    administrator_id: firstInvitation.id,
  });
  expect((await ok(first, myBillingOrganizations)).organizations).toEqual([]);
  expect((await ok(second, myBillingOrganizations)).invitations).toEqual([]);
  for (const accept of [true, false]) {
    const staleResponse = await post(app, billingInvitationRespond, {
      token: second.token,
      body: { invitation_id: staleInvitation.id, accept },
    });
    expect(staleResponse.status).toBe(404);
  }

  const freshInvitation = await ok(operator, operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: second.accountId,
  });
  expect(freshInvitation.id).not.toBe(staleInvitation.id);
  await ok(second, billingInvitationRespond, { invitation_id: freshInvitation.id, accept: true });
  expect((await ok(second, myBillingOrganizations)).organizations).toEqual([
    { slug: organization.slug, name: organization.name, kind: 'team', plan: null, state: 'active' },
  ]);
});
