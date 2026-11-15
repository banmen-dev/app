// 解除の成功判定と、自動失効が触れてよい行の境界。
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  billingAdminInvite,
  billingAdminList,
  billingAdminRemove,
  billingInvitationRespond,
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
async function accept(person: Person, id: string) {
  await ok(person, billingInvitationRespond, { invitation_id: id, accept: true });
}

async function administrators() {
  const organization = await createOrganization();
  const first = await createPerson();
  const second = await createPerson();
  const initial = await ok(await getOperator(), operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: first.accountId,
  });
  await accept(first, initial.id);
  const invited = await ok(first, billingAdminInvite, {
    slug: organization.slug,
    account_id: second.accountId,
  });
  await accept(second, invited.id);
  return { organization, first, second, initial, invited };
}

describe('請求担当者解除の結果', () => {
  test('未承諾指名を出していない担当者の解除も200で確定し、残る担当者はactiveのまま', async () => {
    const { organization, first, second, invited } = await administrators();
    await ok(first, billingAdminRemove, { slug: organization.slug, administrator_id: invited.id });
    const rows = (await ok(first, billingAdminList, { slug: organization.slug })).administrators;
    expect(rows).toContainEqual(expect.objectContaining({ account_id: first.accountId, status: 'active' }));
    expect(rows.map((row) => row.account_id)).not.toContain(second.accountId);
  });
});
