// 先行受け入れテストにない、認可の読取と書込の間の競合・監査の境界。
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
  operatorBillingAdminInvite,
} from '../src/shared/operations/billing.ts';
import type { AnyOperationDefinition, OutputOf } from '../src/shared/operations/define.ts';
import { createOrganization, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, testEnv, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
const db = () => commonDb(env);

async function ok<D extends AnyOperationDefinition>(
  person: Person,
  definition: D,
  body: unknown,
): Promise<OutputOf<D>> {
  const response = await post(app, definition, { token: person.token, body });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function fixture() {
  const organization = await createOrganization();
  const actor = await createPerson();
  const initial = await ok(await getOperator(), operatorBillingAdminInvite, {
    slug: organization.slug,
    account_id: actor.accountId,
  });
  await ok(actor, billingInvitationRespond, { invitation_id: initial.id, accept: true });
  return { organization, actor, actorId: initial.id };
}
async function events(organizationId: string) {
  const common = db();
  return common.rows(
    common.statement((q) =>
      q
        .selectFrom('billing_admin_events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}
async function rows(organizationId: string) {
  const common = db();
  return common.rows(
    common.statement((q) =>
      q.selectFrom('billing_administrators').selectAll().where('organization_id', '=', organizationId).orderBy('id'),
    ),
  );
}
async function revoke(id: string) {
  const common = db();
  await common.batch([
    common.statement((q) => q.updateTable('billing_administrators').set({ status: 'revoked' }).where('id', '=', id)),
  ]);
}
function racingAfter(pattern: string, action: () => Promise<void>) {
  let raced = false;
  const racing = envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (raced || !sql.includes(pattern)) return;
      raced = true;
      await action();
    },
  });
  return { env: racing, happened: () => raced };
}

describe('請求管理の読取と書込の間に変わる権限・状態', () => {
  test('指名を認可した直後に操作者が解除されると新しい指名も監査も書かない', async () => {
    const { organization, actor, actorId } = await fixture();
    const target = await createPerson();
    const before = await events(organization.id);
    const race = racingAfter('from "accounts"', () => revoke(actorId));
    const response = await post(app, billingAdminInvite, {
      token: actor.token,
      body: { slug: organization.slug, account_id: target.accountId },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    expect((await rows(organization.id)).map((row) => row.account_id)).not.toContain(target.accountId);
    expect(await events(organization.id)).toEqual(before);
  });

  test('解除対象を読んだ直後に操作者が解除されると対象者と監査を変えない', async () => {
    const { organization, actor, actorId } = await fixture();
    const target = await createPerson();
    const invited = await ok(actor, billingAdminInvite, { slug: organization.slug, account_id: target.accountId });
    const before = await events(organization.id);
    const race = racingAfter('from "billing_administrators"', () => revoke(actorId));
    const response = await post(app, billingAdminRemove, {
      token: actor.token,
      body: { slug: organization.slug, administrator_id: invited.id },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    expect((await rows(organization.id)).find((row) => row.id === invited.id)?.status).toBe('pending');
    expect(await events(organization.id)).toEqual(before);
  });

  test('一覧の組織認可の直後に解除されると担当者情報・履歴を返さない', async () => {
    const { organization, actor, actorId } = await fixture();
    const race = racingAfter('from "organizations"', () => revoke(actorId));
    const response = await post(app, billingAdminList, {
      token: actor.token,
      body: { slug: organization.slug },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty('administrators');
  });

  test('初回指名の確認後に別担当者が承諾したら運用者から追加できない', async () => {
    const organization = await createOrganization();
    const first = await createPerson();
    const next = await createPerson();
    const operator = await getOperator();
    const invited = await ok(operator, operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: first.accountId,
    });
    const before = await events(organization.id);
    const race = racingAfter('from "accounts"', async () => {
      const common = db();
      await common.batch([
        common.statement((q) =>
          q.updateTable('billing_administrators').set({ status: 'active' }).where('id', '=', invited.id),
        ),
      ]);
    });
    const response = await post(app, operatorBillingAdminInvite, {
      token: operator.token,
      body: { slug: organization.slug, account_id: next.accountId },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    expect((await rows(organization.id)).map((row) => row.account_id)).not.toContain(next.accountId);
    expect(await events(organization.id)).toEqual(before);
  });

  test('承諾の読取後に指名を取り消して再指名した場合は古い要求が新指名を承諾しない', async () => {
    const { organization, actor } = await fixture();
    const target = await createPerson();
    const initial = await ok(actor, billingAdminInvite, { slug: organization.slug, account_id: target.accountId });
    const replacementId = uuidv7();
    const before = await events(organization.id);
    const race = racingAfter('from "billing_administrators" as "b"', async () => {
      const common = db();
      await common.batch([
        common.statement((q) =>
          q
            .updateTable('billing_administrators')
            .set({ id: replacementId, status: 'pending' })
            .where('id', '=', initial.id),
        ),
      ]);
    });
    const response = await post(app, billingInvitationRespond, {
      token: target.token,
      body: { invitation_id: initial.id, accept: true },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    expect((await rows(organization.id)).find((row) => row.id === replacementId)?.status).toBe('pending');
    expect(await events(organization.id)).toEqual(before);
  });

  test('追加の読取後に消去期限を過ぎた状態になったら指名も監査も書かない', async () => {
    const { organization, actor } = await fixture();
    const target = await createPerson();
    const before = await events(organization.id);
    const race = racingAfter('from "accounts"', async () => {
      const common = db();
      await common.batch([
        common.statement((q) =>
          q
            .updateTable('organizations')
            .set({ suspended_at: '2020-01-01T00:00:00.000Z', purge_on: '2020-01-02' })
            .where('id', '=', organization.id),
        ),
      ]);
    });
    const response = await post(app, billingAdminInvite, {
      token: actor.token,
      body: { slug: organization.slug, account_id: target.accountId },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    expect((await rows(organization.id)).map((row) => row.account_id)).not.toContain(target.accountId);
    expect(await events(organization.id)).toEqual(before);
  });

  test('同時の承諾と辞退は片方だけが確定し履歴も1件だけ増える', async () => {
    const { organization, actor } = await fixture();
    const target = await createPerson();
    const invited = await ok(actor, billingAdminInvite, { slug: organization.slug, account_id: target.accountId });
    const before = await events(organization.id);
    const replies = await Promise.all(
      [true, false].map((accept) =>
        post(app, billingInvitationRespond, {
          token: target.token,
          body: { invitation_id: invited.id, accept },
        }),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(await events(organization.id)).toHaveLength(before.length + 1);
    const final = (await rows(organization.id)).find((row) => row.id === invited.id);
    expect(final?.status).toBe(replies[0]!.status === 200 ? 'active' : 'declined');
  });

  test('契約のない最終担当者解除を認可した後に契約が付いても最後の担当者は残る', async () => {
    const { organization, actor, actorId } = await fixture();
    const before = await events(organization.id);
    const race = racingAfter('from "billing_administrators"', async () => {
      const common = db();
      await common.batch([
        common.statement((q) =>
          q.insertInto('organization_contracts').values({
            organization_id: organization.id,
            plan: 'team',
            billing_interval: 'monthly',
            extra_10gb_units: 0,
            extra_50gb_units: 0,
            created_at: '2026-11-15T00:00:00.000Z',
            updated_at: '2026-11-15T00:00:00.000Z',
          }),
        ),
      ]);
    });
    const response = await post(app, billingAdminRemove, {
      token: actor.token,
      body: { slug: organization.slug, administrator_id: actorId },
      env: race.env,
    });
    expect(race.happened()).toBe(true);
    expect(response.status).toBe(409);
    expect((await rows(organization.id)).find((row) => row.id === actorId)?.status).toBe('active');
    expect(await events(organization.id)).toEqual(before);
  });
});
