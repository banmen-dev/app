// #1241 担当組織の契約と使用量（billing-organization-summary）と担当組織の一覧の行（my-billing-organizations）を、
// test/billing-organization-summary.test.ts と重ならない手口で崩しにかかるテスト。
// 権限（slug の綴り、1人の状態の混在、業務の管理者の権限との混同）、人数と容量の数え方（member-list・運用者の一覧との一致）、
// 状態の境目（予定日の前日・翌日、停止していない組織の予定日、お試しと契約の両方、開発用の時計）、応答への業務データの漏れ、
// 一覧の行と詳細の食い違い、読む間の承諾を見る
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { billingOrganizationSummary, myBillingOrganizations } from '../src/shared/operations/billing.ts';
import type { AnyOperationDefinition, OutputOf } from '../src/shared/operations/define.ts';
import { listOrganizations } from '../src/shared/operations/operator/list-organizations.ts';
import { memberList } from '../src/shared/operations/workspace/member-list.ts';
import {
  AT,
  createAttachment,
  createInvitation,
  createMembership,
  createOrganization,
  createTask,
  createUser,
  createWorkspace,
  hash64,
  uuidv7,
  type OrganizationFixture,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, getOperator, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const GIB = 1024 ** 3;

type Summary = OutputOf<typeof billingOrganizationSummary>;

async function ok<D extends AnyOperationDefinition>(
  person: Person,
  definition: D,
  options: { body?: unknown; slug?: string; env?: Env } = {},
): Promise<OutputOf<D>> {
  const response = await post(app, definition, { token: person.token, body: options.body ?? {}, ...options });
  expect(response.status, `${definition.name}: ${await response.clone().text()}`).toBe(200);
  return response.json();
}
function summaryResponse(person: Person, slug: string, override?: Env) {
  return post(app, billingOrganizationSummary, {
    token: person.token,
    body: { slug },
    ...(override === undefined ? {} : { env: override }),
  });
}
async function summary(person: Person, organization: OrganizationFixture, override?: Env): Promise<Summary> {
  const response = await summaryResponse(person, organization.slug, override);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function insertBillingRow(
  organization: OrganizationFixture,
  person: Person,
  status: 'pending' | 'active' | 'revoked' | 'declined',
) {
  const id = uuidv7();
  const invitedBy = (await getOperator()).accountId;
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('billing_administrators').values({
        id,
        organization_id: organization.id,
        account_id: person.accountId,
        status,
        invited_by: invitedBy,
        is_bootstrap: 1,
        created_at: AT,
        updated_at: AT,
      }),
    ),
  ]);
  return id;
}
async function setContract(
  organization: OrganizationFixture,
  values: {
    plan: 'personal' | 'small' | 'team' | 'business' | 'pro' | 'custom';
    billing_interval: 'monthly' | 'yearly';
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
        billing_interval: values.billing_interval,
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
async function updateOrganization(
  organization: OrganizationFixture,
  values: { suspended_at?: string | null; purge_on?: string | null; trial_ends_on?: string | null },
) {
  const db = commonDb(env);
  await db.batch([db.statement((q) => q.updateTable('organizations').set(values).where('id', '=', organization.id))]);
}
async function setStatus(id: string, status: 'active' | 'revoked') {
  const db = commonDb(env);
  await db.batch([db.statement((q) => q.updateTable('billing_administrators').set({ status }).where('id', '=', id))]);
}
async function memberListSeats(target: Target): Promise<number | undefined> {
  const members = await ok(target.admin, memberList, {
    slug: target.slug,
    body: { workspace_id: target.workspace.id },
  });
  return members.seats?.used;
}
async function operatorRow(slug: string, override?: Env) {
  const operator = await getOperator();
  const list = await ok(operator, listOrganizations, override === undefined ? {} : { env: override });
  const row = list.organizations.find((organization) => organization.slug === slug);
  expect(row).toBeDefined();
  return row!;
}
const utcDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
function devEnv(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

describe('権限: slug の綴りと、1人の状態の混在', () => {
  test('大文字・前後の空白・改行・LIKE の記号を混ぜた slug では、承諾済みの担当者でも取れない', async () => {
    const organization = await createOrganization();
    const admin = await createPerson();
    await insertBillingRow(organization, admin, 'active');
    // 綴りの正しい slug では取れる
    await summary(admin, organization);
    const variants = [
      organization.slug.toUpperCase(),
      ` ${organization.slug}`,
      `${organization.slug} `,
      `${organization.slug}\n`,
      `${organization.slug.slice(0, -1)}%`,
      `${organization.slug.slice(0, -1)}_`,
      `${organization.slug}' OR '1'='1`,
    ];
    for (const slug of variants) {
      const response = await summaryResponse(admin, slug);
      expect([400, 404], `${JSON.stringify(slug)}: ${await response.clone().text()}`).toContain(response.status);
      expect(await response.text()).not.toContain('usage');
    }
  });

  test('同じアカウントが A で承諾済み、B で承諾待ち、C で解除済み、D で辞退なら、A だけが取れ、他は存在しない組織と同じ応答', async () => {
    const person = await createPerson();
    const [a, b, c, d] = await Promise.all([
      createOrganization({ name: '架空の甲' }),
      createOrganization({ name: '架空の乙' }),
      createOrganization({ name: '架空の丙' }),
      createOrganization({ name: '架空の丁' }),
    ]);
    await insertBillingRow(a, person, 'active');
    await insertBillingRow(b, person, 'pending');
    await insertBillingRow(c, person, 'revoked');
    await insertBillingRow(d, person, 'declined');

    await summary(person, a);
    const missing = await summaryResponse(person, `missing-${uuidv7().slice(-8)}`);
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    for (const organization of [b, c, d]) {
      const response = await summaryResponse(person, organization.slug);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(missingBody);
    }

    const mine = await ok(person, myBillingOrganizations);
    expect(mine.organizations.map((row) => row.slug)).toEqual([a.slug]);
    expect(mine.invitations.map((row) => row.slug)).toEqual([b.slug]);
  });

  test('A の請求管理者が B の組織管理者・リーダーでも、B の契約と使用量は取れない', async () => {
    const a = await createOrganization();
    const b = await createTarget();
    // B の組織管理者（業務の権限）を、A の請求管理者にする
    await insertBillingRow(a, b.admin, 'active');
    await insertBillingRow(a, b.leader, 'active');
    await summary(b.admin, a);
    for (const person of [b.admin, b.leader]) {
      const response = await summaryResponse(person, b.slug);
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('not_found');
    }
  });

  test('担当外への 404 は、組織の名前・ID・上限を含まない', async () => {
    const organization = await createOrganization({ name: '架空の秘匿組織', member_limit: 777 });
    const owner = await createPerson();
    await insertBillingRow(organization, owner, 'active');
    const outsider = await createPerson();
    await insertBillingRow(organization, outsider, 'pending');
    const response = await summaryResponse(outsider, organization.slug);
    expect(response.status).toBe(404);
    const text = await response.text();
    for (const secret of ['架空の秘匿組織', organization.id, '777', 'member_limit', 'contract']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('人数と容量: member-list・運用者の一覧と同じ値', () => {
  test('期限切れの Google の招待・無効にした人・閉じた場の招待・抜けた人を数えず、重なる人は1人と数える', async () => {
    const target = await createTarget();
    // createTarget の数える人: admin・leader・member・bystander・invitee の5人
    const google = (email: string, expires: string) =>
      createInvitation(
        target.organization,
        target.workspace.id,
        target.admin.userId!,
        { provider: 'google', subject: '' },
        {
          login_subject: null,
          login_email: email,
          claim_token_hash: hash64(),
          claim_expires_at: expires,
          login_name: email,
        },
      );
    // 数える: 期限の来ていない Google の招待（+1）
    await google('kasou-yuuko@example.com', '2099-01-01T00:00:00.000Z');
    // 数えない: 期限切れの Google の招待
    await google('kasou-kireta@example.com', '2020-01-01T00:00:00.000Z');
    // 数えない: 無効にした人と、その人への承諾待ちの招待
    const disabled = await createPerson({
      organization: target.organization,
      disabled: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    await createInvitation(target.organization, target.otherWorkspace.id, target.admin.userId!, disabled.login);
    // 数えない: 閉じたワークスペースへの招待
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      name: '閉じた架空の場',
      closed_at: AT,
    });
    const closedInvitee = await createPerson();
    await createInvitation(target.organization, closed.id, target.admin.userId!, closedInvitee.login);
    // 数えない: ワークスペースを抜けた人（管理者でない）
    const left = await createUser(target.organization, { name: '抜けた架空の人' });
    await createMembership(target.organization, target.workspace.id, left.id, {
      left_on: '2026-10-10',
      left_at: '2026-10-10T00:00:00.000Z',
    });
    // 数えない（重なり）: 所属している人への別のワークスペースの招待
    await createInvitation(target.organization, target.otherWorkspace.id, target.admin.userId!, target.member.login);
    // 数える: どこにも所属しない管理者（+1）
    await createPerson({ organization: target.organization, admin: true });
    // 数えない: 請求専用の人
    const billing = await createPerson();
    await insertBillingRow(target.organization, billing, 'active');

    const result = await summary(billing, target.organization);
    expect(result.usage.seats_used).toBe(7);
    expect(result.usage.seats_used).toBe(await memberListSeats(target));
    expect(result.usage.seats_used).toBe((await operatorRow(target.slug)).seats.used);
  });

  test('同じログインの人が2組織にいても、各組織の人数・容量はその組織の行だけで、運用者の一覧と一致する', async () => {
    const a = await createTarget();
    const b = await createTarget();
    // A の member と同じログインを、B の users と所属にも入れる（別の組織の行）
    const twin = await createUser(b.organization, {
      account_id: a.member.accountId,
      login_provider: a.member.login.provider,
      login_subject: a.member.login.subject,
    });
    await createMembership(b.organization, b.workspace.id, twin.id);
    // B での添付と Wiki は、A と同じ人が上げたもの
    await createAttachment(b.organization, b.workspace.id, twin.id, { size_bytes: 4321 });
    await createAttachment(a.organization, a.workspace.id, a.member.userId!, { size_bytes: 12 });
    // 1人が両方を担当する
    const billing = await createPerson();
    await insertBillingRow(a.organization, billing, 'active');
    await insertBillingRow(b.organization, billing, 'active');

    const resultA = await summary(billing, a.organization);
    const resultB = await summary(billing, b.organization);
    expect(resultA.usage).toEqual({ seats_used: 5, attachment_used_bytes: 12 });
    expect(resultB.usage).toEqual({ seats_used: 6, attachment_used_bytes: 4321 });
    expect(resultA.usage.seats_used).toBe(await memberListSeats(a));
    expect(resultB.usage.seats_used).toBe(await memberListSeats(b));
    for (const [target, result] of [
      [a, resultA],
      [b, resultB],
    ] as const) {
      const row = await operatorRow(target.slug);
      expect(result.usage).toEqual({ seats_used: row.seats.used, attachment_used_bytes: row.attachment_used_bytes });
      expect(result.member_limit).toBe(row.seats.limit);
      expect(result.attachment_quota_bytes).toBe(row.attachment_quota_bytes);
    }
  });

  test('Wiki の過去版と削除済みのページ、閉じた場の添付も容量に入り、運用者の一覧の合計と一致する', async () => {
    const target = await createTarget();
    const closed = await createWorkspace(target.organization, target.admin.userId!, { closed_at: AT });
    await createAttachment(target.organization, closed.id, target.admin.userId!, { size_bytes: 1000 });
    const db = orgDb(env, target.organization.verified);
    const pageId = uuidv7();
    await db.batch([
      db.statement((q) =>
        q.insertInto('wiki_pages').values({
          id: pageId,
          organization_id: null,
          workspace_id: target.workspace.id,
          parent_id: null,
          position: 'a0',
          title: 'abc',
          body_md: 'defg',
          version: 2,
          created_by: target.admin.userId!,
          updated_by: target.admin.userId!,
          created_at: AT,
          updated_at: AT,
          deleted_at: AT,
          deleted_by: target.admin.userId!,
        }),
      ),
      db.statement((q) =>
        q.insertInto('wiki_page_revisions').values({
          page_id: pageId,
          version: 1,
          title: 'xy',
          body_md: 'z',
          saved_by: target.admin.userId!,
          saved_at: AT,
        }),
      ),
    ]);
    const billing = await createPerson();
    await insertBillingRow(target.organization, billing, 'active');
    const result = await summary(billing, target.organization);
    expect(result.usage.attachment_used_bytes).toBe(1000 + 3 + 4 + 2 + 1);
    expect(result.usage.attachment_used_bytes).toBe((await operatorRow(target.slug)).attachment_used_bytes);
  });
});

describe('状態の境目', () => {
  test('消去予定日の前日（UTC）は purge_due、翌日はまだ purge_due でない', async () => {
    const person = await createPerson();
    const yesterday = await createOrganization();
    const tomorrow = await createOrganization();
    await insertBillingRow(yesterday, person, 'active');
    await insertBillingRow(tomorrow, person, 'active');
    await updateOrganization(yesterday, { suspended_at: '2026-10-01T00:00:00.000Z', purge_on: utcDate(-1) });
    await updateOrganization(tomorrow, { suspended_at: '2026-10-01T00:00:00.000Z', purge_on: utcDate(1) });
    expect(await summary(person, yesterday)).toMatchObject({ state: 'cancelled', purge_due: true });
    expect(await summary(person, tomorrow)).toMatchObject({ state: 'cancelled', purge_due: false });
    // 運用者の一覧と同じ境目
    expect((await operatorRow(yesterday.slug)).purge_due).toBe(true);
    expect((await operatorRow(tomorrow.slug)).purge_due).toBe(false);
  });

  test('停止していない組織に purge_on が残る不整合でも、状態は利用中で purge_due にならず、一覧の行も利用中', async () => {
    const person = await createPerson();
    const organization = await createOrganization();
    await insertBillingRow(organization, person, 'active');
    await updateOrganization(organization, { suspended_at: null, purge_on: '2020-01-01' });
    const result = await summary(person, organization);
    expect(result.state).toBe('active');
    expect(result.purge_due).toBe(false);
    const row = (await ok(person, myBillingOrganizations)).organizations.find((r) => r.slug === organization.slug);
    expect(row?.state).toBe('active');
  });

  test('お試しの期限と契約の両方がある組織は、契約とお試しの期限を両方返し、一覧の行はそのプラン', async () => {
    const person = await createPerson();
    const organization = await createOrganization({ trial_ends_on: '2026-12-31' });
    await setContract(organization, { plan: 'small', billing_interval: 'yearly' });
    await insertBillingRow(organization, person, 'active');
    const result = await summary(person, organization);
    expect(result).toMatchObject({ state: 'active', trial_ends_on: '2026-12-31' });
    expect(result.contract).toMatchObject({ plan: 'small', billing_interval: 'yearly' });
    const row = (await ok(person, myBillingOrganizations)).organizations.find((r) => r.slug === organization.slug);
    expect(row).toMatchObject({ plan: 'small', state: 'active' });
  });

  test('開発用の時計を実際の今日より前に止めても、purge_due は運用者の一覧と同じ値になる', async () => {
    // docs/data-model.md: purge_due は「運用者の一覧と同じ境目（停止していて purge_on が今日（UTC）より前）」。
    // 運用者の一覧（src/server/operations/operator.ts）は Worker の now() の日付だけで決める
    const devNow = '2020-01-01T00:00:00Z';
    const purgeOn = '2020-06-01';
    const person = await createPerson();
    const organization = await createOrganization({ suspended_at: '2019-12-01T00:00:00.000Z', purge_on: purgeOn });
    await insertBillingRow(organization, person, 'active');
    const clocked = devEnv(devNow);
    const result = await summary(person, organization, clocked);
    const row = await operatorRow(organization.slug, clocked);
    expect(row.purge_due).toBe(false);
    expect(result.purge_due).toBe(row.purge_due);
  });
});

describe('応答に業務データが漏れない', () => {
  test('添付のファイル名・タスクの題・人の名前とログイン・組織と人の ID を応答に含まない', async () => {
    const target = await createTarget();
    await createAttachment(target.organization, target.workspace.id, target.admin.userId!, {
      file_name: '架空の機密資料.pdf',
      size_bytes: 10,
    });
    await createTask(target.organization, target.workspace.id, target.admin.userId!, { title: '架空の極秘タスク' });
    const named = await createUser(target.organization, { name: '架空の秘書', is_admin: 1 });
    const billing = await createPerson();
    await insertBillingRow(target.organization, billing, 'active');
    const response = await summaryResponse(billing, target.slug);
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of [
      '架空の機密資料',
      '架空の極秘タスク',
      '架空の秘書',
      target.organization.id,
      target.organization.name,
      named.id,
      named.login_subject!,
      target.member.login.subject,
      target.admin.userId!,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('一覧の行と詳細が食い違わない', () => {
  test('一覧の各行の plan と state は、その組織の詳細の contract.plan と state と同じ', async () => {
    const person = await createPerson();
    const active = await createOrganization();
    const suspended = await createOrganization();
    const cancelled = await createOrganization();
    const custom = await createOrganization({ member_limit: 70, attachment_quota_bytes: 3 * GIB });
    await setContract(suspended, { plan: 'pro', billing_interval: 'monthly' });
    await setContract(cancelled, { plan: 'business', billing_interval: 'yearly' });
    await setContract(custom, {
      plan: 'custom',
      billing_interval: 'monthly',
      custom_member_limit: 70,
      custom_attachment_quota_bytes: 3 * GIB,
    });
    for (const organization of [active, suspended, cancelled, custom]) {
      await insertBillingRow(organization, person, 'active');
    }
    await updateOrganization(suspended, { suspended_at: '2026-11-01T00:00:00.000Z' });
    await updateOrganization(cancelled, { suspended_at: '2026-11-01T00:00:00.000Z', purge_on: '2099-01-01' });
    const rows = (await ok(person, myBillingOrganizations)).organizations;
    expect(rows).toHaveLength(4);
    for (const organization of [active, suspended, cancelled, custom]) {
      const row = rows.find((r) => r.slug === organization.slug);
      const detail = await summary(person, organization);
      expect(row?.plan ?? null).toBe(detail.contract?.plan ?? null);
      expect(row?.state).toBe(detail.state);
      expect(row?.kind).toBe(detail.kind);
    }
    expect(rows.find((r) => r.slug === custom.slug)?.plan).toBe('custom');
  });
});

describe('読む間の承諾（ランタイム）', () => {
  test('承諾待ちの人の読み取りの途中で承諾されても、最初の確かめで外れたので使用量を返さない', async () => {
    const target = await createTarget();
    await createAttachment(target.organization, target.workspace.id, target.admin.userId!, { size_bytes: 888 });
    const person = await createPerson();
    const id = await insertBillingRow(target.organization, person, 'pending');
    let raced = false;
    const race = async (sqls: readonly string[]) => {
      if (raced || !sqls.some((sql) => sql.includes('billing_administrators'))) return;
      raced = true;
      await setStatus(id, 'active');
    };
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: (sql) => race([sql]),
      afterBatch: (sqls) => race(sqls),
    });
    const response = await summaryResponse(person, target.slug, racing);
    expect(raced).toBe(true);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain('usage');
    expect(text).not.toContain('888');
    // 承諾が確定した後の読み取りでは取れる
    expect((await summary(person, target.organization)).usage.attachment_used_bytes).toBe(888);
  });

  test('読み取りの途中で別の組織の担当だけが解除されても、この組織の読み取りは成り立つ', async () => {
    const target = await createTarget();
    const other = await createOrganization();
    const person = await createPerson();
    await insertBillingRow(target.organization, person, 'active');
    const otherId = await insertBillingRow(other, person, 'active');
    let raced = false;
    const race = async (sqls: readonly string[]) => {
      if (raced || !sqls.some((sql) => /"attachments"|wiki_pages|"invitations"/.test(sql))) return;
      raced = true;
      await setStatus(otherId, 'revoked');
    };
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: (sql) => race([sql]),
      afterBatch: (sqls) => race(sqls),
    });
    const result = await summary(person, target.organization, racing);
    expect(raced).toBe(true);
    expect(result.usage.seats_used).toBe(5);
    const response = await summaryResponse(person, other.slug);
    expect(response.status).toBe(404);
  });
});
