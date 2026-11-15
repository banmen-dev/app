import { env } from 'cloudflare:workers';
import { commonDb } from '../src/server/db/index.ts';
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
  myBillingOrganizations,
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

describe('解除に伴う未承諾指名の失効範囲', () => {
  test('別組織の指名と承諾済みの担当者を失効させず、再指名元の解除で新指名は失効する', async () => {
    const { organization, first, second, initial, invited } = await administrators();
    const other = await createOrganization();
    const nominee = await createPerson();
    const otherFirst = await ok(await getOperator(), operatorBillingAdminInvite, {
      slug: other.slug,
      account_id: first.accountId,
    });
    await accept(first, otherFirst.id);
    const otherInvitation = await ok(first, billingAdminInvite, {
      slug: other.slug,
      account_id: nominee.accountId,
    });
    const old = await ok(first, billingAdminInvite, {
      slug: organization.slug,
      account_id: nominee.accountId,
    });
    await ok(second, billingAdminRemove, { slug: organization.slug, administrator_id: initial.id });
    await accept(nominee, otherInvitation.id);
    const renewedFirst = await ok(second, billingAdminInvite, {
      slug: organization.slug,
      account_id: first.accountId,
    });
    await accept(first, renewedFirst.id);
    const renewed = await ok(second, billingAdminInvite, {
      slug: organization.slug,
      account_id: nominee.accountId,
    });
    expect(renewed.id).not.toBe(old.id);
    await ok(first, billingAdminRemove, { slug: organization.slug, administrator_id: invited.id });
    expect((await ok(nominee, myBillingOrganizations)).invitations.map((row) => row.id)).not.toContain(renewed.id);
    expect(
      (
        await post(app, billingInvitationRespond, {
          token: nominee.token,
          body: { invitation_id: renewed.id, accept: true },
        })
      ).status,
    ).toBe(404);
    expect((await ok(nominee, myBillingOrganizations)).organizations).toContainEqual(
      expect.objectContaining({ slug: other.slug }),
    );
  });

  test('自動失効は通常指名だけを更新し、bootstrap行には触れない', async () => {
    const { organization, first, second, initial } = await administrators();
    const nominee = await createPerson();
    const invitation = await ok(first, billingAdminInvite, {
      slug: organization.slug,
      account_id: nominee.accountId,
    });
    const db = commonDb(env);
    // この境界は通常APIでは同時に存在しないため、DBの判別条件を直接検証する。
    await db.batch([
      db.statement((q) =>
        q.updateTable('billing_administrators').set({ is_bootstrap: 1 }).where('id', '=', invitation.id),
      ),
    ]);
    await ok(second, billingAdminRemove, { slug: organization.slug, administrator_id: initial.id });
    const row = await db.first(
      db.statement((q) =>
        q.selectFrom('billing_administrators').select(['status', 'is_bootstrap']).where('id', '=', invitation.id),
      ),
    );
    expect(row).toEqual({ status: 'pending', is_bootstrap: 1 });
    expect((await ok(second, billingAdminList, { slug: organization.slug })).administrators).toContainEqual(
      expect.objectContaining({ account_id: second.accountId, status: 'active' }),
    );
  });
});
