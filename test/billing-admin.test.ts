// 請求担当者の本人承諾・交代・業務権限からの分離。API を通して受け入れ条件を検査する。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb, seatHoldersOf } from '../src/server/db/index.ts';
import { billingOperations } from '../src/server/operations/billing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { attachmentList } from '../src/shared/operations/attachment/index.ts';
import {
  billingAdminInvite,
  billingAdminList,
  billingAdminRemove,
  billingInvitationRespond,
  myBillingOrganizations,
  operatorBillingAdminInvite,
} from '../src/shared/operations/billing.ts';
import type { AnyOperationDefinition, OutputOf } from '../src/shared/operations/define.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { taskDetail } from '../src/shared/operations/task/task-detail.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { orgWikiTree } from '../src/shared/operations/wiki/index.ts';
import { createOrganization, createTask, uuidv7, type OrganizationFixture } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, getOperator, testEnv, type Person } from './operations/world.ts';

const billingNames = new Set(billingOperations.map((operation) => operation.definition.name));
const app = createApp([
  ...implementedOperations.filter((operation) => !billingNames.has(operation.definition.name)),
  ...billingOperations,
]);

async function ok<D extends AnyOperationDefinition>(
  person: Person,
  definition: D,
  body: unknown = {},
): Promise<OutputOf<D>> {
  const response = await post(app, definition, { token: person.token, body });
  expect(response.status, `${definition.name}: ${await response.clone().text()}`).toBe(200);
  return response.json();
}
async function inviteFirst(organization: OrganizationFixture, person: Person) {
  return ok(await getOperator(), operatorBillingAdminInvite, { slug: organization.slug, account_id: person.accountId });
}
async function accept(person: Person, id: string) {
  await ok(person, billingInvitationRespond, { invitation_id: id, accept: true });
}
async function withBilling(
  organization = undefined as OrganizationFixture | undefined,
  person = undefined as Person | undefined,
) {
  const org = organization ?? (await createOrganization());
  const admin = person ?? (await createPerson());
  const invitation = await inviteFirst(org, admin);
  await accept(admin, invitation.id);
  return { organization: org, admin, id: invitation.id };
}
async function list(person: Person, organization: OrganizationFixture) {
  return ok(person, billingAdminList, { slug: organization.slug });
}
async function add(organization: OrganizationFixture, admin: Person, target: Person) {
  return ok(admin, billingAdminInvite, { slug: organization.slug, account_id: target.accountId });
}
async function remove(person: Person, organization: OrganizationFixture, id: string) {
  return post(app, billingAdminRemove, {
    token: person.token,
    body: { slug: organization.slug, administrator_id: id },
  });
}
async function contract(organization: OrganizationFixture) {
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
}

describe('請求管理者の本人承諾と権限', () => {
  test('所属ゼロの本人も自分のIDを確認でき、初回指名は承諾前に権限を与えない', async () => {
    const organization = await createOrganization();
    const person = await createPerson();
    const before = await ok(person, myBillingOrganizations);
    expect(before.account_id).toBe(person.accountId);
    expect(before.operator).toBe(false);
    expect(before.organizations).toEqual([]);
    const invitation = await inviteFirst(organization, person);
    const pending = await ok(person, myBillingOrganizations);
    expect(pending.invitations).toContainEqual({ id: invitation.id, slug: organization.slug, name: organization.name });
    expect(pending.organizations).toEqual([]);
    expect((await post(app, billingAdminList, { token: person.token, body: { slug: organization.slug } })).status).toBe(
      404,
    );
    await accept(person, invitation.id);
    const after = await ok(person, myBillingOrganizations);
    expect(after.organizations).toContainEqual({
      slug: organization.slug,
      name: organization.name,
      kind: 'team',
      plan: null,
      state: 'active',
    });
    expect(after.invitations).toEqual([]);
    expect((await list(person, organization)).administrators).toEqual([
      expect.objectContaining({ id: invitation.id, account_id: person.accountId, status: 'active' }),
    ]);
  });

  test('組織管理者・メンバー・第三者に初回指名や請求管理権限を自動付与しない', async () => {
    const target = await createTarget();
    const outsider = await createPerson();
    for (const person of [target.admin, target.member, outsider]) {
      const body = { slug: target.slug, account_id: outsider.accountId };
      expect((await post(app, operatorBillingAdminInvite, { token: person.token, body })).status).toBe(403);
      expect((await post(app, billingAdminInvite, { token: person.token, body })).status).toBe(404);
      expect((await post(app, billingAdminList, { token: person.token, body: { slug: target.slug } })).status).toBe(
        404,
      );
    }
  });

  test('宛先本人以外の承諾・辞退を拒み、本人は辞退できる', async () => {
    const organization = await createOrganization();
    const person = await createPerson();
    const outsider = await createPerson();
    const invitation = await inviteFirst(organization, person);
    for (const accepted of [true, false]) {
      expect(
        (
          await post(app, billingInvitationRespond, {
            token: outsider.token,
            body: { invitation_id: invitation.id, accept: accepted },
          })
        ).status,
      ).toBe(404);
    }
    await ok(person, billingInvitationRespond, { invitation_id: invitation.id, accept: false });
    expect((await ok(person, myBillingOrganizations)).invitations).toEqual([]);
    expect((await ok(person, myBillingOrganizations)).organizations).toEqual([]);
  });

  test('承諾済み担当者は追加でき、承諾前の指名先は第三者を追加できない', async () => {
    const { organization, admin } = await withBilling();
    const target = await createPerson();
    const next = await createPerson();
    const invitation = await add(organization, admin, target);
    expect(
      (
        await post(app, billingAdminInvite, {
          token: target.token,
          body: { slug: organization.slug, account_id: next.accountId },
        })
      ).status,
    ).toBe(404);
    await accept(target, invitation.id);
    await add(organization, target, next);
    expect((await list(target, organization)).administrators).toHaveLength(3);
  });

  test('担当者が承諾済みの組織に運用者が新しい担当者を割り込ませない', async () => {
    const { organization } = await withBilling();
    const target = await createPerson();
    const response = await post(app, operatorBillingAdminInvite, {
      token: (await getOperator()).token,
      body: { slug: organization.slug, account_id: target.accountId },
    });
    expect(response.status).toBe(409);
  });

  test('既存アカウントのないIDは指名できず、対象が無いことを返す', async () => {
    const { organization, admin } = await withBilling();
    expect(
      (
        await post(app, billingAdminInvite, {
          token: admin.token,
          body: { slug: organization.slug, account_id: uuidv7() },
        })
      ).status,
    ).toBe(404);
  });

  test('別組織の担当者一覧・指名・解除は存在しない組織と同じ404になる', async () => {
    const first = await withBilling();
    const second = await withBilling();
    const target = await createPerson();
    for (const slug of [second.organization.slug, `missing-${uuidv7().slice(-8)}`]) {
      expect((await post(app, billingAdminList, { token: first.admin.token, body: { slug } })).status).toBe(404);
      expect(
        (
          await post(app, billingAdminInvite, {
            token: first.admin.token,
            body: { slug, account_id: target.accountId },
          })
        ).status,
      ).toBe(404);
      expect(
        (await post(app, billingAdminRemove, { token: first.admin.token, body: { slug, administrator_id: second.id } }))
          .status,
      ).toBe(404);
    }
    expect((await remove(first.admin, first.organization, second.id)).status).toBe(404);
    expect((await list(second.admin, second.organization)).administrators).toHaveLength(1);
  });

  test('未認証・異なるOrigin・APIトークンからの入口を拒む', async () => {
    const person = await createPerson();
    expect((await post(app, myBillingOrganizations)).status).toBe(401);
    expect(
      (await post(app, myBillingOrganizations, { token: person.token, origin: 'https://evil.example' })).status,
    ).toBe(403);
    const token = await insertApiToken(person.accountId);
    expect((await post(app, myBillingOrganizations, { bearer: token.raw })).status).toBe(403);
  });
});

describe('複数組織・人数・業務利用からの分離', () => {
  test('1人が2組織の担当を持ち、1組織が複数担当を持てる', async () => {
    const person = await createPerson();
    const first = await withBilling(undefined, person);
    const second = await withBilling(undefined, person);
    const extra = await createPerson();
    const invitation = await add(first.organization, person, extra);
    await accept(extra, invitation.id);
    const mine = await ok(person, myBillingOrganizations);
    expect(mine.organizations.map((row) => row.slug).sort()).toEqual(
      [first.organization.slug, second.organization.slug].sort(),
    );
    expect((await list(person, first.organization)).administrators).toHaveLength(2);
    expect((await list(person, second.organization)).administrators).toHaveLength(1);
    expect((await ok(extra, myBillingOrganizations)).organizations).toEqual([
      { slug: first.organization.slug, name: first.organization.name, kind: 'team', plan: null, state: 'active' },
    ]);
  });

  test('人数上限でも請求専用担当者を増やせ、users・所属・人数を増やさない', async () => {
    const target = await createTarget();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ member_limit: 1 }).where('id', '=', target.organization.id),
      ),
    ]);
    const db = orgDb(env, target.organization.verified);
    const beforeUsers = await db.rows(
      db.statement((q) => q.selectFrom('users').select('id').where('organization_id', '=', target.organization.id)),
    );
    const beforeSeats = await seatHoldersOf(db, new Date());
    const billing = await withBilling(target.organization);
    const extra = await createPerson();
    await accept(extra, (await add(target.organization, billing.admin, extra)).id);
    expect(
      await db.rows(
        db.statement((q) => q.selectFrom('users').select('id').where('organization_id', '=', target.organization.id)),
      ),
    ).toEqual(beforeUsers);
    expect(await seatHoldersOf(db, new Date())).toEqual(beforeSeats);
    const mine = await ok(billing.admin, myOrganizations);
    expect(mine.organizations).toEqual([]);
    expect(mine.invitations).toEqual([]);
  });

  test('請求専用担当者が組織・Wiki・添付・タスクのAPIへ入れない', async () => {
    const target = await createTarget();
    const billing = await withBilling(target.organization);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    for (const [definition, body] of [
      [organizationInfo, {}],
      [orgWikiTree, {}],
      [taskDetail, { workspace_id: target.workspace.id, task_id: task.id }],
      [attachmentList, { workspace_id: target.workspace.id, task_id: task.id }],
    ] as const) {
      expect((await post(app, definition, { token: billing.admin.token, slug: target.slug, body })).status).toBe(404);
    }
    const response = await app.request(
      `/api/${target.slug}/attachments/${uuidv7()}`,
      { headers: { Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${billing.admin.token}` } },
      testEnv,
    );
    expect(response.status).toBe(404);
  });

  test('組織管理者と請求管理者を兼任しても人数を二重に数えず業務権限を維持する', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const before = await seatHoldersOf(db, new Date());
    await withBilling(target.organization, target.admin);
    expect(await seatHoldersOf(db, new Date())).toEqual(before);
    expect((await post(app, organizationInfo, { slug: target.slug, token: target.admin.token })).status).toBe(200);
  });
});

describe('交代・最終担当者・監査・再送', () => {
  test('新担当者が承諾してから旧担当者を解除しても契約と組織は残る', async () => {
    const { organization, admin, id } = await withBilling();
    await contract(organization);
    const next = await createPerson();
    const invitation = await add(organization, admin, next);
    await accept(next, invitation.id);
    expect((await remove(next, organization, id)).status).toBe(200);
    expect((await ok(admin, myBillingOrganizations)).organizations).toEqual([]);
    expect((await list(next, organization)).administrators).toEqual([
      expect.objectContaining({ account_id: next.accountId, status: 'active' }),
    ]);
    const db = commonDb(env);
    expect(
      await db.first(
        db.statement((q) =>
          q.selectFrom('organization_contracts').selectAll().where('organization_id', '=', organization.id),
        ),
      ),
    ).toEqual(expect.objectContaining({ plan: 'team', billing_interval: 'monthly' }));
    expect(
      await db.first(db.statement((q) => q.selectFrom('organizations').select('id').where('id', '=', organization.id))),
    ).toBeDefined();
  });

  test('契約中の最後の担当者は未承諾の後任がいても解除できない', async () => {
    const { organization, admin, id } = await withBilling();
    await contract(organization);
    await add(organization, admin, await createPerson());
    expect((await remove(admin, organization, id)).status).toBe(409);
    expect((await list(admin, organization)).administrators.filter((row) => row.status === 'active')).toHaveLength(1);
  });

  test('同時の自己解除でも契約中の担当者がゼロにならない', async () => {
    const { organization, admin, id } = await withBilling();
    await contract(organization);
    const other = await createPerson();
    const invitation = await add(organization, admin, other);
    await accept(other, invitation.id);
    const results = await Promise.all([remove(admin, organization, id), remove(other, organization, invitation.id)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const survivor = results[0]!.status === 200 ? other : admin;
    expect((await list(survivor, organization)).administrators.filter((row) => row.status === 'active')).toHaveLength(
      1,
    );
  });

  test('未契約なら最後の担当者を解除でき、運用者が再指名できる', async () => {
    const { organization, admin, id } = await withBilling();
    expect((await remove(admin, organization, id)).status).toBe(200);
    const next = await createPerson();
    await accept(next, (await inviteFirst(organization, next)).id);
    expect((await list(next, organization)).administrators).toHaveLength(1);
  });

  test('再指名後に古い指名IDで承諾・解除できない', async () => {
    const { organization, admin } = await withBilling();
    const target = await createPerson();
    const old = await add(organization, admin, target);
    expect((await remove(admin, organization, old.id)).status).toBe(200);
    const fresh = await add(organization, admin, target);
    expect(fresh.id).not.toBe(old.id);
    const stale = await post(app, billingInvitationRespond, {
      token: target.token,
      body: { invitation_id: old.id, accept: true },
    });
    expect([404, 409]).toContain(stale.status);
    expect((await remove(admin, organization, old.id)).status).toBe(404);
    expect((await ok(target, myBillingOrganizations)).invitations).toContainEqual(
      expect.objectContaining({ id: fresh.id }),
    );
  });

  test('辞退済みの人を再指名すると新しいIDになり本人が承諾できる', async () => {
    const { organization, admin } = await withBilling();
    const person = await createPerson();
    const old = await add(organization, admin, person);
    await ok(person, billingInvitationRespond, { invitation_id: old.id, accept: false });
    const fresh = await add(organization, admin, person);
    expect(fresh.id).not.toBe(old.id);
    await accept(person, fresh.id);
    expect((await list(person, organization)).administrators).toContainEqual(
      expect.objectContaining({ account_id: person.accountId, status: 'active' }),
    );
  });

  test('指名・承諾・辞退・解除を記録し、拒否と承諾再送は偽の履歴を残さない', async () => {
    const { organization, admin } = await withBilling();
    const person = await createPerson();
    const invitation = await add(organization, admin, person);
    await accept(person, invitation.id);
    const before = await list(admin, organization);
    const replay = await post(app, billingInvitationRespond, {
      token: person.token,
      body: { invitation_id: invitation.id, accept: true },
    });
    expect([200, 404, 409]).toContain(replay.status);
    expect((await list(admin, organization)).events).toEqual(before.events);
    expect((await remove(admin, organization, invitation.id)).status).toBe(200);
    const declined = await add(organization, admin, person);
    await ok(person, billingInvitationRespond, { invitation_id: declined.id, accept: false });
    const events = (await list(admin, organization)).events;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_account_id: admin.accountId,
          target_account_id: person.accountId,
          action: 'invited',
        }),
        expect.objectContaining({
          actor_account_id: person.accountId,
          target_account_id: person.accountId,
          action: 'accepted',
        }),
        expect.objectContaining({
          actor_account_id: admin.accountId,
          target_account_id: person.accountId,
          action: 'removed',
        }),
        expect.objectContaining({
          actor_account_id: person.accountId,
          target_account_id: person.accountId,
          action: 'declined',
        }),
      ]),
    );
    expect(events).toHaveLength(7);
    const denied = await post(app, billingAdminInvite, {
      token: person.token,
      body: { slug: organization.slug, account_id: admin.accountId },
    });
    expect(denied.status).toBe(404);
    expect((await list(admin, organization)).events).toEqual(events);
  });

  test('承諾済み担当者への重複指名は権限を承諾待ちに戻さず履歴を増やさない', async () => {
    const { organization, admin } = await withBilling();
    const before = await list(admin, organization);
    const response = await post(app, billingAdminInvite, {
      token: admin.token,
      body: { slug: organization.slug, account_id: admin.accountId },
    });
    expect([200, 409]).toContain(response.status);
    expect(await list(admin, organization)).toEqual(before);
  });

  test('停止中でも請求担当者を交代でき、業務用組織の停止は解けない', async () => {
    const organization = await createOrganization({ suspended_at: '2026-11-01T00:00:00.000Z' });
    const { admin } = await withBilling(organization);
    const next = await createPerson();
    await accept(next, (await add(organization, admin, next)).id);
    expect((await list(next, organization)).administrators).toHaveLength(2);
    const db = commonDb(env);
    expect(
      (
        await db.first(
          db.statement((q) => q.selectFrom('organizations').select('suspended_at').where('id', '=', organization.id)),
        )
      )?.suspended_at,
    ).toBe(organization.suspended_at);
  });

  test('消去予定日を過ぎた組織には初回指名できない', async () => {
    const organization = await createOrganization({ suspended_at: '2020-01-01T00:00:00.000Z', purge_on: '2020-02-01' });
    const target = await createPerson();
    expect(
      (
        await post(app, operatorBillingAdminInvite, {
          token: (await getOperator()).token,
          body: { slug: organization.slug, account_id: target.accountId },
        })
      ).status,
    ).toBe(409);
  });

  test('消去予定日を過ぎた後の追加・承諾・解除は拒み監査を増やさない', async () => {
    const { organization, admin, id } = await withBilling();
    const person = await createPerson();
    const invitation = await add(organization, admin, person);
    const before = await list(admin, organization);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ suspended_at: '2020-01-01T00:00:00.000Z', purge_on: '2020-02-01' })
          .where('id', '=', organization.id),
      ),
    ]);
    expect(
      (
        await post(app, billingAdminInvite, {
          token: admin.token,
          body: { slug: organization.slug, account_id: (await createPerson()).accountId },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(app, billingInvitationRespond, {
          token: person.token,
          body: { invitation_id: invitation.id, accept: true },
        })
      ).status,
    ).toBe(409);
    expect((await remove(admin, organization, id)).status).toBe(409);
    expect((await list(admin, organization)).events).toEqual(before.events);
  });
});
