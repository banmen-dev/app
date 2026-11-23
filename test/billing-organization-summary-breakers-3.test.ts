// #1241 担当組織の契約と使用量（billing-organization-summary）と担当組織の一覧（my-billing-organizations）を、
// 1周目・2周目に無い手口で崩しにかかる（3周目）。
// 見るのは、解約した組織のデータを消す SQL（scripts/purge-organization-sql.ts）を流した後と流す途中の形、
// 基準値が空の古い個別契約、契約の行が組織の種類と食い違う不整合な行
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { purgeOrganizationSql } from '../scripts/purge-organization-sql.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { runStatementsForTest, sqlLines } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { billingOrganizationSummary, myBillingOrganizations } from '../src/shared/operations/billing.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import {
  AT,
  createAttachment,
  createOrganization,
  createUser,
  createWorkspace,
  uuidv7,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
const GIB = 1024 ** 3;
type Summary = OutputOf<typeof billingOrganizationSummary>;

async function makeActive(organization: OrganizationFixture, person: Person) {
  const invitedBy = (await getOperator()).accountId;
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('billing_administrators').values({
        id: uuidv7(),
        organization_id: organization.id,
        account_id: person.accountId,
        status: 'active',
        invited_by: invitedBy,
        is_bootstrap: 1,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
}
async function setContract(
  organization: OrganizationFixture,
  values: {
    plan: 'personal' | 'small' | 'team' | 'business' | 'pro' | 'custom';
    custom_member_limit?: number | null;
    custom_attachment_quota_bytes?: number | null;
  },
) {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('organization_contracts').values({
        organization_id: organization.id,
        plan: values.plan,
        billing_interval: 'monthly',
        extra_10gb_units: 0,
        extra_50gb_units: 0,
        custom_member_limit: values.custom_member_limit ?? null,
        custom_attachment_quota_bytes: values.custom_attachment_quota_bytes ?? null,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
}
const summaryResponse = (person: Person, slug: string) =>
  post(app, billingOrganizationSummary, { token: person.token, body: { slug } });
async function summaryOf(person: Person, slug: string): Promise<Summary> {
  const response = await summaryResponse(person, slug);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function listOf(person: Person): Promise<OutputOf<typeof myBillingOrganizations>> {
  const response = await post(app, myBillingOrganizations, { token: person.token, body: {} });
  expect(response.status).toBe(200);
  return response.json();
}
// 解約で停止し、消す予定日を過ぎた組織（消す SQL の守りの条件を満たす）
async function cancelledPastDue() {
  return createOrganization({ suspended_at: '2020-01-01T00:00:00.000Z', purge_on: '2020-02-01' });
}

describe('解約した組織のデータを消す SQL の後', () => {
  test('消し終えた組織は担当組織の一覧から消え、契約と使用量は存在しない組織と同じ 404', async () => {
    const organization = await cancelledPastDue();
    const other = await createOrganization();
    const admin = await createPerson();
    await makeActive(organization, admin);
    await makeActive(other, admin);
    await setContract(organization, { plan: 'team' });
    const user = await createUser(organization);
    const workspace = await createWorkspace(organization, user.id);
    await createAttachment(organization, workspace.id, user.id, { size_bytes: 1024 });
    // 消す前は、予定日を過ぎていても読める
    expect((await summaryOf(admin, organization.slug)).state).toBe('cancelled');

    await runStatementsForTest(env, sqlLines(purgeOrganizationSql(organization.id)));

    const response = await summaryResponse(admin, organization.slug);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    const list = await listOf(admin);
    expect(list.organizations.map((row) => row.slug)).toEqual([other.slug]);
    // 残った組織はそのまま読める
    expect((await summaryOf(admin, other.slug)).state).toBe('active');
  });

  test('消す途中（担当者の行を消した後、organizations の行が残る間）は、担当者にも 404 で一覧にも出ない', async () => {
    const organization = await cancelledPastDue();
    const admin = await createPerson();
    await makeActive(organization, admin);
    await setContract(organization, { plan: 'team' });
    const statements = sqlLines(purgeOrganizationSql(organization.id));
    const cut = statements.findIndex((statement) => statement.startsWith('DELETE FROM billing_administrators '));
    expect(cut).toBeGreaterThan(0);
    await runStatementsForTest(env, statements.slice(0, cut + 1));

    expect((await summaryResponse(admin, organization.slug)).status).toBe(404);
    expect((await listOf(admin)).organizations).toEqual([]);
  });

  test('消す途中（担当者の行が残り、契約の行だけ先に消えた間）は、未契約として読め、一覧の行も plan が null', async () => {
    const organization = await cancelledPastDue();
    const admin = await createPerson();
    await makeActive(organization, admin);
    await setContract(organization, { plan: 'pro' });
    // 契約の行だけを消した形（手順の途中で止まった、か、行の順の違い）
    const db = commonDb(env);
    await db.batch([
      db.statement((q) => q.deleteFrom('organization_contracts').where('organization_id', '=', organization.id)),
    ]);

    const result = await summaryOf(admin, organization.slug);
    expect(result.contract).toBeNull();
    expect(result.state).toBe('cancelled');
    expect(result.purge_due).toBe(true);
    expect((await listOf(admin)).organizations).toEqual([
      { slug: organization.slug, name: organization.name, kind: 'team', plan: null, state: 'cancelled' },
    ]);
  });
});

describe('古い行と不整合な行', () => {
  test('基準値が空の古い個別契約も 500 にせず、custom の2列を null のまま返す', async () => {
    const organization = await createOrganization({ member_limit: 80, attachment_quota_bytes: 200 * GIB });
    const admin = await createPerson();
    await makeActive(organization, admin);
    await setContract(organization, { plan: 'custom' });

    const result = await summaryOf(admin, organization.slug);
    expect(result.contract).toEqual({
      plan: 'custom',
      billing_interval: 'monthly',
      extra_10gb_units: 0,
      extra_50gb_units: 0,
      custom_member_limit: null,
      custom_attachment_quota_bytes: null,
    });
    // 上限は organizations に写した値
    expect(result.member_limit).toBe(80);
    expect(result.attachment_quota_bytes).toBe(200 * GIB);
    expect((await listOf(admin)).organizations[0]).toMatchObject({ plan: 'custom' });
  });

  test('チーム用の組織に personal の契約、自分用の組織に team の契約という食い違った行も、列の値をそのまま返す', async () => {
    const team = await createOrganization();
    const personal = await createOrganization({ kind: 'personal', member_limit: 1, attachment_quota_bytes: GIB });
    const admin = await createPerson();
    await makeActive(team, admin);
    await makeActive(personal, admin);
    await setContract(team, { plan: 'personal' });
    await setContract(personal, { plan: 'team' });

    const teamSummary = await summaryOf(admin, team.slug);
    const personalSummary = await summaryOf(admin, personal.slug);
    expect([teamSummary.kind, teamSummary.contract?.plan]).toEqual(['team', 'personal']);
    expect([personalSummary.kind, personalSummary.contract?.plan]).toEqual(['personal', 'team']);
    const rows = (await listOf(admin)).organizations;
    expect(rows.find((row) => row.slug === team.slug)).toMatchObject({ kind: 'team', plan: 'personal' });
    expect(rows.find((row) => row.slug === personal.slug)).toMatchObject({ kind: 'personal', plan: 'team' });
  });
});
