// PR #1244 再レビュー: 通常指名をした担当者が復帰しても、解除前の未承諾指名を復活させない。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  billingAdminInvite,
  billingAdminList,
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
async function accept(person: Person, id: string) {
  await ok(person, billingInvitationRespond, { invitation_id: id, accept: true });
}
async function fixture() {
  const organization = await createOrganization();
  const first = await createPerson();
  const second = await createPerson();
  const nominee = await createPerson();
  const initial = await ok(await getOperator(), operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: first.accountId,
  });
  await accept(first, initial.id);
  const secondInvitation = await ok(first, billingAdminInvite, {
    slug: organization.slug,
    account_id: second.accountId,
  });
  await accept(second, secondInvitation.id);
  const nomineeInvitation = await ok(first, billingAdminInvite, {
    slug: organization.slug,
    account_id: nominee.accountId,
  });
  await ok(second, billingAdminRemove, { slug: organization.slug, administrator_id: initial.id });
  const renewedFirst = await ok(second, billingAdminInvite, { slug: organization.slug, account_id: first.accountId });
  await accept(first, renewedFirst.id);
  return { organization, first, second, nominee, nomineeInvitation };
}
async function events(organizationId: string) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('billing_admin_events').selectAll().where('organization_id', '=', organizationId).orderBy('id'),
    ),
  );
}

describe('通常指名元の復帰後も解除前の指名は恒久失効する', () => {
  test('AがXを指名した後にAを解除・再指名・承諾してもXの古い指名は一覧に戻らない', async () => {
    const { first, second, organization, nominee, nomineeInvitation } = await fixture();
    const administrators = (await ok(second, billingAdminList, { slug: organization.slug })).administrators;
    expect(administrators).toContainEqual(expect.objectContaining({ account_id: first.accountId, status: 'active' }));
    const mine = await ok(nominee, myBillingOrganizations);
    expect(mine.invitations.map((row) => row.id)).not.toContain(nomineeInvitation.id);
    expect(mine.organizations).toEqual([]);
  });

  test.each([true, false])(
    '復帰した指名元の古い指名への応答 accept=%s は404で監査を変えない',
    async (acceptInvitation) => {
      const { organization, second, nominee, nomineeInvitation } = await fixture();
      const before = await events(organization.id);
      const response = await post(app, billingInvitationRespond, {
        token: nominee.token,
        body: { invitation_id: nomineeInvitation.id, accept: acceptInvitation },
      });
      expect(response.status).toBe(404);
      expect(await events(organization.id)).toEqual(before);
      const administrators = (await ok(second, billingAdminList, { slug: organization.slug })).administrators;
      expect(administrators).not.toContainEqual(
        expect.objectContaining({ account_id: nominee.accountId, status: 'active' }),
      );
    },
  );

  test('現在のBがXを再指名すれば新IDで承諾でき、Aが復帰していても旧IDは404のままになる', async () => {
    const { organization, second, nominee, nomineeInvitation } = await fixture();
    const renewed = await ok(second, billingAdminInvite, { slug: organization.slug, account_id: nominee.accountId });
    expect(renewed.id).not.toBe(nomineeInvitation.id);
    const mine = await ok(nominee, myBillingOrganizations);
    expect(mine.invitations).toContainEqual(expect.objectContaining({ id: renewed.id }));
    expect(mine.invitations.map((row) => row.id)).not.toContain(nomineeInvitation.id);
    const oldResponse = await post(app, billingInvitationRespond, {
      token: nominee.token,
      body: { invitation_id: nomineeInvitation.id, accept: true },
    });
    expect(oldResponse.status).toBe(404);
    await accept(nominee, renewed.id);
    expect((await ok(second, billingAdminList, { slug: organization.slug })).administrators).toContainEqual(
      expect.objectContaining({ account_id: nominee.accountId, status: 'active' }),
    );
  });

  test('契約中最後の担当者の自己解除を409で拒んだら、その人の未承諾指名は失効させない', async () => {
    const organization = await createOrganization();
    const administrator = await createPerson();
    const nominee = await createPerson();
    const initial = await ok(await getOperator(), operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: administrator.accountId,
    });
    await accept(administrator, initial.id);
    const invitation = await ok(administrator, billingAdminInvite, {
      slug: organization.slug,
      account_id: nominee.accountId,
    });
    const db = commonDb(env);
    const at = '2026-11-01T00:00:00.000Z';
    await db.batch([
      db.statement((q) =>
        q.insertInto('organization_contracts').values({
          organization_id: organization.id,
          plan: 'team',
          billing_interval: 'monthly',
          extra_10gb_units: 0,
          extra_50gb_units: 0,
          created_at: at,
          updated_at: at,
        }),
      ),
    ]);
    const before = await events(organization.id);
    const response = await post(app, billingAdminRemove, {
      token: administrator.token,
      body: { slug: organization.slug, administrator_id: initial.id },
    });
    expect(response.status).toBe(409);
    expect(await events(organization.id)).toEqual(before);
    expect((await ok(nominee, myBillingOrganizations)).invitations).toContainEqual(
      expect.objectContaining({ id: invitation.id }),
    );
    await accept(nominee, invitation.id);
    const active = (await ok(administrator, billingAdminList, { slug: organization.slug })).administrators.filter(
      (row) => row.status === 'active',
    );
    expect(active).toHaveLength(2);
  });
});
