// PR #1244 の指摘: 指名元の権限失効と、請求権限を書き換える入口の回数制限。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
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
import { createOrganization, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, testEnv, type Person } from './operations/world.ts';

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
async function accept(person: Person, invitationId: string) {
  await ok(person, billingInvitationRespond, { invitation_id: invitationId, accept: true });
}
async function twoAdministrators() {
  const organization = await createOrganization();
  const first = await createPerson();
  const second = await createPerson();
  const initial = await ok(await getOperator(), operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: first.accountId,
  });
  await accept(first, initial.id);
  const added = await ok(first, billingAdminInvite, { slug: organization.slug, account_id: second.accountId });
  await accept(second, added.id);
  return { organization, first, second, firstId: initial.id };
}
async function expiredNomination() {
  const fixture = await twoAdministrators();
  const nominee = await createPerson();
  const invitation = await ok(fixture.first, billingAdminInvite, {
    slug: fixture.organization.slug,
    account_id: nominee.accountId,
  });
  await ok(fixture.second, billingAdminRemove, { slug: fixture.organization.slug, administrator_id: fixture.firstId });
  return { ...fixture, nominee, invitation };
}
async function storedEvents(organizationId: string) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('billing_admin_events').selectAll().where('organization_id', '=', organizationId).orderBy('id'),
    ),
  );
}

// 担当者の承諾を読み取ったあと、書き込む前に他の要求が確定する順序を固定する。
function afterInvitationRead(action: () => Promise<void>) {
  let happened = false;
  const wrapped = envWithD1Hooks(testEnv, {
    afterQuery: async (query) => {
      if (
        happened ||
        !query.includes('from "billing_administrators" as "b"') ||
        !query.includes('join "organizations"')
      )
        return;
      happened = true;
      await action();
    },
  });
  return { env: wrapped, happened: () => happened };
}

describe('指名を承諾するときの指名元の権限', () => {
  test('指名元が引き続き担当者なら兼任者も新しい担当者を指名し承諾できる', async () => {
    const { organization, first, second } = await twoAdministrators();
    const nominee = await createPerson({ organization, admin: true });
    const invitation = await ok(second, billingAdminInvite, { slug: organization.slug, account_id: nominee.accountId });
    await accept(nominee, invitation.id);
    const listed = await ok(first, billingAdminList, { slug: organization.slug });
    expect(listed.administrators.filter((row) => row.status === 'active')).toHaveLength(3);
    expect(listed.administrators).toContainEqual(
      expect.objectContaining({ account_id: nominee.accountId, status: 'active' }),
    );
  });

  test('指名元を解除したら未承諾の指名は本人の一覧から消える', async () => {
    const { nominee, invitation } = await expiredNomination();
    const mine = await ok(nominee, myBillingOrganizations);
    expect(mine.invitations.map((row) => row.id)).not.toContain(invitation.id);
    expect(mine.organizations).toEqual([]);
  });

  test('指名元が既に解除された指名を直接承諾しても権限も監査も増えない', async () => {
    const { organization, second, nominee, invitation } = await expiredNomination();
    const before = await storedEvents(organization.id);
    const response = await post(app, billingInvitationRespond, {
      token: nominee.token,
      body: { invitation_id: invitation.id, accept: true },
    });
    expect(response.status).toBe(404);
    expect(await storedEvents(organization.id)).toEqual(before);
    expect((await ok(second, billingAdminList, { slug: organization.slug })).administrators).not.toContainEqual(
      expect.objectContaining({ account_id: nominee.accountId, status: 'active' }),
    );
  });

  test('現在の担当者が失効した指名先を再指名すると新IDで承諾でき古いIDは使えない', async () => {
    const { organization, second, nominee, invitation } = await expiredNomination();
    const fresh = await ok(second, billingAdminInvite, { slug: organization.slug, account_id: nominee.accountId });
    expect(fresh.id).not.toBe(invitation.id);
    const mine = await ok(nominee, myBillingOrganizations);
    expect(mine.invitations).toContainEqual(expect.objectContaining({ id: fresh.id }));
    expect(mine.invitations.map((row) => row.id)).not.toContain(invitation.id);
    const stale = await post(app, billingInvitationRespond, {
      token: nominee.token,
      body: { invitation_id: invitation.id, accept: true },
    });
    expect(stale.status).toBe(404);
    await accept(nominee, fresh.id);
    expect((await ok(second, billingAdminList, { slug: organization.slug })).administrators).toContainEqual(
      expect.objectContaining({ account_id: nominee.accountId, status: 'active' }),
    );
  });

  test('最初の担当者が承諾すると残りの運用者初回指名は失効し現在の担当者が再指名できる', async () => {
    const organization = await createOrganization();
    const first = await createPerson();
    const second = await createPerson();
    const operator = await getOperator();
    const firstInvitation = await ok(operator, operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: first.accountId,
    });
    const oldSecond = await ok(operator, operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: second.accountId,
    });
    await accept(first, firstInvitation.id);
    expect((await ok(second, myBillingOrganizations)).invitations.map((row) => row.id)).not.toContain(oldSecond.id);
    const oldResponse = await post(app, billingInvitationRespond, {
      token: second.token,
      body: { invitation_id: oldSecond.id, accept: true },
    });
    expect(oldResponse.status).toBe(404);
    const freshSecond = await ok(first, billingAdminInvite, { slug: organization.slug, account_id: second.accountId });
    expect(freshSecond.id).not.toBe(oldSecond.id);
    await accept(second, freshSecond.id);
    expect(
      (await ok(first, billingAdminList, { slug: organization.slug })).administrators.filter(
        (row) => row.status === 'active',
      ),
    ).toHaveLength(2);
  });

  test('承諾の読取と書込の間に指名元を解除しても承諾と監査を書かない', async () => {
    const { organization, first, second, firstId } = await twoAdministrators();
    const nominee = await createPerson();
    const invitation = await ok(first, billingAdminInvite, { slug: organization.slug, account_id: nominee.accountId });
    const race = afterInvitationRead(async () => {
      await ok(second, billingAdminRemove, { slug: organization.slug, administrator_id: firstId });
    });
    const response = await post(app, billingInvitationRespond, {
      token: nominee.token,
      body: { invitation_id: invitation.id, accept: true },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    const events = await storedEvents(organization.id);
    expect(events).not.toContainEqual(
      expect.objectContaining({ target_account_id: nominee.accountId, action: 'accepted' }),
    );
  });

  test('初回指名の同時承諾で先に別の担当者が確定したら後の承諾を通さない', async () => {
    const organization = await createOrganization();
    const first = await createPerson();
    const second = await createPerson();
    const operator = await getOperator();
    const firstInvitation = await ok(operator, operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: first.accountId,
    });
    const secondInvitation = await ok(operator, operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: second.accountId,
    });
    const race = afterInvitationRead(() => accept(first, firstInvitation.id));
    const response = await post(app, billingInvitationRespond, {
      token: second.token,
      body: { invitation_id: secondInvitation.id, accept: true },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    const active = (await ok(first, billingAdminList, { slug: organization.slug })).administrators.filter(
      (row) => row.status === 'active',
    );
    expect(active).toEqual([expect.objectContaining({ account_id: first.accountId })]);
  });
});

const writes = [billingAdminInvite, billingAdminRemove, billingInvitationRespond, operatorBillingAdminInvite] as const;

describe('請求管理の書込の回数制限', () => {
  test.each(writes.map((definition) => [definition.name, definition] as const))(
    '%s は同一アカウントで10分に30回まで、31回目は429になる',
    async (_name, definition) => {
      // どの口でも同じ個人を数える。運用者の口ではこのテスト専用の運用者にして他のテストの指名回数と独立させる。
      const person = await createPerson();
      const requestEnv = Object.assign({}, testEnv, {
        OPERATOR_LOGIN_IDS: `${person.login.provider}:${person.login.subject}`,
      });
      const missingId = uuidv7();
      const body =
        definition.name === 'billing-invitation-respond'
          ? { invitation_id: missingId, accept: true }
          : definition.name === 'billing-admin-remove'
            ? { slug: `missing-${missingId.slice(-8)}`, administrator_id: missingId }
            : { slug: `missing-${missingId.slice(-8)}`, account_id: person.accountId };
      for (let request = 1; request <= 30; request++) {
        const response = await post(app, definition, { token: person.token, body, env: requestEnv });
        expect(response.status, `request ${request}`).toBe(404);
      }
      const refused = await post(app, definition, { token: person.token, body, env: requestEnv });
      expect(refused.status).toBe(429);
      expect(await errorCodeOf(refused)).toBe('rate_limited');
      const secondPerson = await createPerson();
      const secondEnv = Object.assign({}, testEnv, {
        OPERATOR_LOGIN_IDS: `${secondPerson.login.provider}:${secondPerson.login.subject}`,
      });
      expect((await post(app, definition, { token: secondPerson.token, body, env: secondEnv })).status).toBe(404);
      const otherDefinition = definition.name === 'billing-admin-remove' ? billingAdminInvite : billingAdminRemove;
      const otherBody =
        otherDefinition.name === 'billing-admin-invite'
          ? { slug: `missing-${missingId.slice(-8)}`, account_id: person.accountId }
          : { slug: `missing-${missingId.slice(-8)}`, administrator_id: missingId };
      expect((await post(app, otherDefinition, { token: person.token, body: otherBody, env: requestEnv })).status).toBe(
        404,
      );
      expect((definition as AnyOperationDefinition).rateLimit).toEqual({ max: 30, windowSeconds: 600 });
    },
  );
});

describe('既存API契約の厳密な回帰確認と一覧の表示', () => {
  test('重複指名は200と同じID、承諾再送は409、解除後再指名の旧IDは404になる', async () => {
    const { organization, first } = await twoAdministrators();
    const nominee = await createPerson();
    const invitation = await ok(first, billingAdminInvite, { slug: organization.slug, account_id: nominee.accountId });
    const pendingDuplicate = await ok(first, billingAdminInvite, {
      slug: organization.slug,
      account_id: nominee.accountId,
    });
    expect(pendingDuplicate.id).toBe(invitation.id);
    await accept(nominee, invitation.id);
    const acceptedDuplicate = await ok(first, billingAdminInvite, {
      slug: organization.slug,
      account_id: nominee.accountId,
    });
    expect(acceptedDuplicate.id).toBe(invitation.id);
    const beforeReplay = await storedEvents(organization.id);
    const replay = await post(app, billingInvitationRespond, {
      token: nominee.token,
      body: { invitation_id: invitation.id, accept: true },
    });
    expect(replay.status).toBe(409);
    expect(await storedEvents(organization.id)).toEqual(beforeReplay);
    await ok(first, billingAdminRemove, { slug: organization.slug, administrator_id: invitation.id });
    const renewed = await ok(first, billingAdminInvite, { slug: organization.slug, account_id: nominee.accountId });
    expect(renewed.id).not.toBe(invitation.id);
    const oldResponse = await post(app, billingInvitationRespond, {
      token: nominee.token,
      body: { invitation_id: invitation.id, accept: true },
    });
    expect(oldResponse.status).toBe(404);
    await accept(nominee, renewed.id);
  });

  test('消去予定日を過ぎた組織の未承諾指名は本人の一覧に出さない', async () => {
    const { organization, first } = await twoAdministrators();
    const nominee = await createPerson();
    const invitation = await ok(first, billingAdminInvite, { slug: organization.slug, account_id: nominee.accountId });
    expect((await ok(nominee, myBillingOrganizations)).invitations).toContainEqual(
      expect.objectContaining({ id: invitation.id }),
    );
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ suspended_at: '2020-01-01T00:00:00.000Z', purge_on: '2020-02-01' })
          .where('id', '=', organization.id),
      ),
    ]);
    expect((await ok(nominee, myBillingOrganizations)).invitations.map((row) => row.id)).not.toContain(invitation.id);
  });

  test('監査の操作者と対象はプロフィール名を返し、名前がない人はIDを返す', async () => {
    const { organization, first, second } = await twoAdministrators();
    const db = commonDb(env);
    const at = '2026-11-01T00:00:00.000Z';
    await db.batch([
      db.statement((q) =>
        q.insertInto('account_profiles').values([
          { account_id: first.accountId, name: '青葉 経理', title: '', created_at: at, updated_at: at },
          { account_id: second.accountId, name: '若葉 契約', title: '', created_at: at, updated_at: at },
        ]),
      ),
    ]);
    const listed = await ok(first, billingAdminList, { slug: organization.slug });
    expect(listed.events).toContainEqual(
      expect.objectContaining({
        actor_account_id: first.accountId,
        target_account_id: second.accountId,
        actor_name: '青葉 経理',
        target_name: '若葉 契約',
        action: 'invited',
      }),
    );
    const operator = await getOperator();
    expect(listed.events).toContainEqual(
      expect.objectContaining({
        actor_account_id: operator.accountId,
        target_account_id: first.accountId,
        actor_name: operator.accountId,
        target_name: '青葉 経理',
        action: 'invited',
      }),
    );
  });
});
