// #1241 請求管理者が担当組織の契約・上限・利用の状態・使用量を見る（billing-organization-summary）と、
// 担当組織の一覧の行（my-billing-organizations の { slug, name, kind, plan, state }）。API を通して受け入れ条件を検査する。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb, organizationStorageBytes, seatHoldersOf } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  billingAdminInvite,
  billingAdminRemove,
  billingInvitationRespond,
  billingOrganizationSummary,
  myBillingOrganizations,
  operatorBillingAdminInvite,
} from '../src/shared/operations/billing.ts';
import type { AnyOperationDefinition, OutputOf } from '../src/shared/operations/define.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { memberList } from '../src/shared/operations/workspace/member-list.ts';
import {
  AT,
  createAttachment,
  createOrganization,
  createTask,
  createWorkspace,
  uuidv7,
  type OrganizationFixture,
} from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import {
  createPerson,
  createPersonalTarget,
  createTarget,
  getOperator,
  testEnv,
  type Person,
} from './operations/world.ts';

const app = createApp(implementedOperations);
const GIB = 1024 ** 3;

type Summary = OutputOf<typeof billingOrganizationSummary>;
type ContractValues = {
  plan: 'personal' | 'small' | 'team' | 'business' | 'pro' | 'custom';
  billing_interval: 'monthly' | 'yearly';
  extra_10gb_units?: number;
  extra_50gb_units?: number;
  custom_member_limit?: number | null;
  custom_attachment_quota_bytes?: number | null;
};

async function ok<D extends AnyOperationDefinition>(
  person: Person,
  definition: D,
  body: unknown = {},
): Promise<OutputOf<D>> {
  const response = await post(app, definition, { token: person.token, body });
  expect(response.status, `${definition.name}: ${await response.clone().text()}`).toBe(200);
  return response.json();
}
function summaryResponse(person: Person, slug: string, testEnvOverride?: Env) {
  return post(app, billingOrganizationSummary, {
    token: person.token,
    body: { slug },
    ...(testEnvOverride === undefined ? {} : { env: testEnvOverride }),
  });
}
async function summary(person: Person, organization: OrganizationFixture): Promise<Summary> {
  return ok(person, billingOrganizationSummary, { slug: organization.slug });
}
async function expectNotFound(person: Person, slug: string) {
  const response = await summaryResponse(person, slug);
  expect(response.status, `${slug}: ${await response.clone().text()}`).toBe(404);
  expect(await errorCodeOf(response)).toBe('not_found');
}
// 担当者の行を直に足す（運用者の初回指名は回数制限があるので、ファイルの中で何度も通さない）。
// 指名者は運用者のアカウントで、運用者の初回指名（is_bootstrap）と同じ形。指名の ID を返す
async function insertBillingRow(organization: OrganizationFixture, person: Person, status: 'pending' | 'active') {
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
// 承諾済みの担当者
async function withBilling(organization?: OrganizationFixture, person?: Person) {
  const org = organization ?? (await createOrganization());
  const admin = person ?? (await createPerson());
  const id = await insertBillingRow(org, admin, 'active');
  return { organization: org, admin, id };
}
async function setContract(organization: OrganizationFixture, values: ContractValues) {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('organization_contracts').values({
        organization_id: organization.id,
        plan: values.plan,
        billing_interval: values.billing_interval,
        extra_10gb_units: values.extra_10gb_units ?? 0,
        extra_50gb_units: values.extra_50gb_units ?? 0,
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
async function setStatus(id: string, status: 'revoked' | 'declined') {
  const db = commonDb(env);
  await db.batch([db.statement((q) => q.updateTable('billing_administrators').set({ status }).where('id', '=', id))]);
}
// 容量の通知（attachment-quota-warning）と同じ数え方の、組織の添付と Wiki の合計
async function storageBytesOf(organization: OrganizationFixture): Promise<number> {
  const db = orgDb(env, organization.verified);
  const row = await db.first(db.statement((q) => q.selectNoFrom(organizationStorageBytes(db).as('bytes'))));
  return Number(row?.bytes ?? 0);
}
async function seatsOf(organization: OrganizationFixture): Promise<number> {
  return (await seatHoldersOf(orgDb(env, organization.verified), new Date())).size;
}
async function addWikiPage(organization: OrganizationFixture, workspaceId: string | null, authorId: string) {
  const db = orgDb(env, organization.verified);
  const id = uuidv7();
  await db.batch([
    db.statement((q) =>
      q.insertInto('wiki_pages').values({
        id,
        organization_id: workspaceId === null ? organization.id : null,
        workspace_id: workspaceId,
        parent_id: null,
        position: 'a0',
        title: '架空の手順',
        body_md: '本文の例',
        version: 1,
        created_by: authorId,
        updated_by: authorId,
        created_at: AT,
        updated_at: AT,
        deleted_at: null,
        deleted_by: null,
      }),
    ),
  ]);
  return new TextEncoder().encode('架空の手順本文の例').byteLength;
}
// オブジェクトの深いキーの集合（配列は添字を [] にまとめる）
function deepKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => deepKeys(item, `${prefix}[]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [path, ...deepKeys(child, path)];
  });
}
const todayUtc = () => new Date().toISOString().slice(0, 10);
const SUMMARY_KEYS = [
  'attachment_quota_bytes',
  'contract',
  'kind',
  'member_limit',
  'purge_due',
  'purge_on',
  'state',
  'trial_ends_on',
  'usage',
  'usage.attachment_used_bytes',
  'usage.seats_used',
];
const CONTRACT_KEYS = [
  'contract.billing_interval',
  'contract.custom_attachment_quota_bytes',
  'contract.custom_member_limit',
  'contract.extra_10gb_units',
  'contract.extra_50gb_units',
  'contract.plan',
];

describe('完了条件: 承諾済みの担当者が契約・上限・状態・使用量を見る', () => {
  test('契約のある組織は、プラン・周期・追加容量の口数と、organizations の今の上限を返す', async () => {
    const organization = await createOrganization({ member_limit: 30, attachment_quota_bytes: 200 * GIB });
    await setContract(organization, {
      plan: 'business',
      billing_interval: 'yearly',
      extra_10gb_units: 2,
      extra_50gb_units: 1,
    });
    const { admin } = await withBilling(organization);
    expect(await summary(admin, organization)).toEqual({
      kind: 'team',
      state: 'active',
      purge_on: null,
      purge_due: false,
      trial_ends_on: null,
      contract: {
        plan: 'business',
        billing_interval: 'yearly',
        extra_10gb_units: 2,
        extra_50gb_units: 1,
        custom_member_limit: null,
        custom_attachment_quota_bytes: null,
      },
      member_limit: 30,
      attachment_quota_bytes: 200 * GIB,
      usage: { seats_used: 0, attachment_used_bytes: 0 },
    });
  });

  test('未契約の組織は contract が null で、上限は organizations の値', async () => {
    const organization = await createOrganization();
    const { admin } = await withBilling(organization);
    const result = await summary(admin, organization);
    expect(result.contract).toBeNull();
    expect(result.member_limit).toBe(organization.member_limit);
    expect(result.attachment_quota_bytes).toBe(organization.attachment_quota_bytes);
    expect(result.state).toBe('active');
  });

  test('個別契約は人数と容量の個別の標準値も返す', async () => {
    const organization = await createOrganization({ member_limit: 40, attachment_quota_bytes: 5 * GIB });
    await setContract(organization, {
      plan: 'custom',
      billing_interval: 'monthly',
      custom_member_limit: 40,
      custom_attachment_quota_bytes: 5 * GIB,
    });
    const { admin } = await withBilling(organization);
    const result = await summary(admin, organization);
    expect(result.contract).toEqual({
      plan: 'custom',
      billing_interval: 'monthly',
      extra_10gb_units: 0,
      extra_50gb_units: 0,
      custom_member_limit: 40,
      custom_attachment_quota_bytes: 5 * GIB,
    });
    expect(result.member_limit).toBe(40);
    expect(result.attachment_quota_bytes).toBe(5 * GIB);
  });

  test('組織管理者を兼ねる請求管理者も、請求専用の担当者と同じ値を見る', async () => {
    const target = await createTarget();
    await setContract(target.organization, { plan: 'team', billing_interval: 'monthly' });
    const { admin: billingOnly } = await withBilling(target.organization);
    const invitation = await ok(billingOnly, billingAdminInvite, {
      slug: target.slug,
      account_id: target.admin.accountId,
    });
    await ok(target.admin, billingInvitationRespond, { invitation_id: invitation.id, accept: true });
    expect(await summary(target.admin, target.organization)).toEqual(await summary(billingOnly, target.organization));
  });

  test('1人が2組織を担当すると、組織ごとにその組織の値を返す', async () => {
    const person = await createPerson();
    const first = await createOrganization({ member_limit: 10 });
    const second = await createOrganization({ member_limit: 50 });
    await setContract(first, { plan: 'small', billing_interval: 'monthly' });
    await withBilling(first, person);
    await withBilling(second, person);
    const a = await summary(person, first);
    const b = await summary(person, second);
    expect(a.contract?.plan).toBe('small');
    expect(a.member_limit).toBe(10);
    expect(b.contract).toBeNull();
    expect(b.member_limit).toBe(50);
  });
});

describe('断る場合: 承諾済みの担当者でなければ存在しない組織と同じ 404', () => {
  test('未承諾（指名だけ）の人は 404', async () => {
    const organization = await createOrganization();
    const person = await createPerson();
    await ok(await getOperator(), operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: person.accountId,
    });
    await expectNotFound(person, organization.slug);
  });

  test('辞退した人は 404', async () => {
    const organization = await createOrganization();
    const person = await createPerson();
    const invitation = await ok(await getOperator(), operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: person.accountId,
    });
    await ok(person, billingInvitationRespond, { invitation_id: invitation.id, accept: false });
    await expectNotFound(person, organization.slug);
  });

  test('解除された元の担当者は 404（解除の前は取れる）', async () => {
    const { organization, admin, id } = await withBilling();
    const next = await createPerson();
    const invitation = await ok(admin, billingAdminInvite, { slug: organization.slug, account_id: next.accountId });
    await ok(next, billingInvitationRespond, { invitation_id: invitation.id, accept: true });
    await summary(admin, organization);
    await ok(next, billingAdminRemove, { slug: organization.slug, administrator_id: id });
    await expectNotFound(admin, organization.slug);
    await summary(next, organization);
  });

  test('行が revoked・declined に変わった担当者は 404', async () => {
    for (const status of ['revoked', 'declined'] as const) {
      const { organization, admin, id } = await withBilling();
      await setStatus(id, status);
      await expectNotFound(admin, organization.slug);
    }
  });

  test('別の組織だけの担当者は 404 で、存在しない組織と同じ応答', async () => {
    const first = await withBilling();
    const second = await withBilling();
    const missing = `missing-${uuidv7().slice(-8)}`;
    const other = await summaryResponse(first.admin, second.organization.slug);
    const absent = await summaryResponse(first.admin, missing);
    expect(other.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await other.json()).toEqual(await absent.json());
  });

  test('その組織の組織管理者・リーダー・メンバー（請求の権限無し）は 404', async () => {
    const target = await createTarget();
    await withBilling(target.organization);
    for (const person of [target.admin, target.leader, target.member, target.bystander, target.invitee]) {
      await expectNotFound(person, target.slug);
    }
  });

  test('第三者と、存在しない slug は 404', async () => {
    const { organization } = await withBilling();
    const outsider = await createPerson();
    await expectNotFound(outsider, organization.slug);
    await expectNotFound(outsider, `missing-${uuidv7().slice(-8)}`);
  });

  test('運用者でも承諾済みの担当者でなければ 404', async () => {
    const { organization } = await withBilling();
    await expectNotFound(await getOperator(), organization.slug);
  });

  test('未認証は 401、別の Origin は 403', async () => {
    const { organization, admin } = await withBilling();
    expect((await post(app, billingOrganizationSummary, { body: { slug: organization.slug } })).status).toBe(401);
    expect(
      (
        await post(app, billingOrganizationSummary, {
          token: admin.token,
          origin: 'https://evil.example',
          body: { slug: organization.slug },
        })
      ).status,
    ).toBe(403);
  });

  test('cookieOnly: 承諾済みの担当者でも API トークンでは呼べない', async () => {
    const { organization, admin } = await withBilling();
    expect(billingOrganizationSummary.cookieOnly).toBe(true);
    for (const scope of ['read', 'write'] as const) {
      const token = await insertApiToken(admin.accountId, { scope });
      const response = await post(app, billingOrganizationSummary, {
        bearer: token.raw,
        origin: null,
        body: { slug: organization.slug },
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('seats_used');
    }
  });
});

describe('組織の分離', () => {
  test('2組織の担当者は互いの値を取れず、人数と容量は自分の組織の行だけで数える', async () => {
    const a = await createTarget();
    const b = await createTarget();
    await setContract(a.organization, { plan: 'team', billing_interval: 'monthly' });
    await setContract(b.organization, { plan: 'pro', billing_interval: 'yearly', extra_50gb_units: 3 });
    await createAttachment(a.organization, a.workspace.id, a.admin.userId!, { size_bytes: 100 });
    await createAttachment(b.organization, b.workspace.id, b.admin.userId!, { size_bytes: 999 });
    const extra = await createPerson({
      organization: b.organization,
      membership: { workspaceId: b.workspace.id, role: 'member' },
    });
    expect(extra.userId).not.toBeNull();
    const billingA = await withBilling(a.organization);
    const billingB = await withBilling(b.organization);

    const resultA = await summary(billingA.admin, a.organization);
    const resultB = await summary(billingB.admin, b.organization);
    expect(resultA.contract?.plan).toBe('team');
    expect(resultB.contract?.plan).toBe('pro');
    expect(resultA.usage).toEqual({ seats_used: await seatsOf(a.organization), attachment_used_bytes: 100 });
    expect(resultB.usage).toEqual({ seats_used: await seatsOf(b.organization), attachment_used_bytes: 999 });
    expect(resultB.usage.seats_used).toBe(resultA.usage.seats_used + 1);

    await expectNotFound(billingA.admin, b.slug);
    await expectNotFound(billingB.admin, a.slug);
  });

  test('ほかの組織に行を足しても、自分の組織の使用量は変わらない', async () => {
    const mine = await createTarget();
    const { admin } = await withBilling(mine.organization);
    const before = await summary(admin, mine.organization);
    const other = await createTarget();
    await createAttachment(other.organization, other.workspace.id, other.admin.userId!, { size_bytes: 4096 });
    await addWikiPage(other.organization, null, other.admin.userId!);
    await createPerson({
      organization: other.organization,
      membership: { workspaceId: other.workspace.id, role: 'member' },
    });
    expect((await summary(admin, mine.organization)).usage).toEqual(before.usage);
  });
});

describe('利用の状態', () => {
  test('利用中は active で、消去予定日は null、purge_due は false', async () => {
    const { organization, admin } = await withBilling();
    const result = await summary(admin, organization);
    expect(result).toMatchObject({ state: 'active', purge_on: null, purge_due: false });
  });

  test('一時的な停止（消去予定日が空）は suspended で、契約と使用量も返す', async () => {
    const target = await createTarget();
    await setContract(target.organization, { plan: 'team', billing_interval: 'monthly' });
    await createAttachment(target.organization, target.workspace.id, target.admin.userId!, { size_bytes: 321 });
    const { admin } = await withBilling(target.organization);
    const seats = await seatsOf(target.organization);
    await updateOrganization(target.organization, { suspended_at: '2026-11-01T00:00:00.000Z', purge_on: null });
    const result = await summary(admin, target.organization);
    expect(result).toMatchObject({ state: 'suspended', purge_on: null, purge_due: false });
    expect(result.contract?.plan).toBe('team');
    expect(result.usage).toEqual({ seats_used: seats, attachment_used_bytes: 321 });
  });

  test('解約で停止し消去予定日の前は cancelled で予定日を返し、purge_due は false', async () => {
    const { organization, admin } = await withBilling();
    await updateOrganization(organization, { suspended_at: '2026-11-01T00:00:00.000Z', purge_on: '2099-12-31' });
    expect(await summary(admin, organization)).toMatchObject({
      state: 'cancelled',
      purge_on: '2099-12-31',
      purge_due: false,
    });
  });

  test('消去予定日の当日（UTC）はまだ purge_due にならない', async () => {
    const { organization, admin } = await withBilling();
    const today = todayUtc();
    await updateOrganization(organization, { suspended_at: '2026-11-01T00:00:00.000Z', purge_on: today });
    expect(await summary(admin, organization)).toMatchObject({ state: 'cancelled', purge_on: today, purge_due: false });
  });

  test('消去予定日を過ぎた後も契約と使用量を返し、purge_due は true', async () => {
    const target = await createTarget();
    await setContract(target.organization, { plan: 'small', billing_interval: 'yearly' });
    await createAttachment(target.organization, target.workspace.id, target.admin.userId!, { size_bytes: 55 });
    const { admin } = await withBilling(target.organization);
    const seats = await seatsOf(target.organization);
    await updateOrganization(target.organization, { suspended_at: '2020-01-01T00:00:00.000Z', purge_on: '2020-02-01' });
    const result = await summary(admin, target.organization);
    expect(result).toMatchObject({ state: 'cancelled', purge_on: '2020-02-01', purge_due: true });
    expect(result.contract?.plan).toBe('small');
    expect(result.usage).toEqual({ seats_used: seats, attachment_used_bytes: 55 });
  });

  test('お試し中は利用中のまま、お試しの期限を返す', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-12-15' });
    const { admin } = await withBilling(organization);
    expect(await summary(admin, organization)).toMatchObject({
      state: 'active',
      trial_ends_on: '2026-12-15',
      contract: null,
    });
  });

  test('自分用の組織は kind personal で、その上限を返す', async () => {
    const target = await createPersonalTarget();
    const { admin } = await withBilling(target.organization);
    const result = await summary(admin, target.organization);
    expect(result.kind).toBe('personal');
    expect(result.member_limit).toBe(target.organization.member_limit);
    expect(result.attachment_quota_bytes).toBe(target.organization.attachment_quota_bytes);
    expect(result.usage.seats_used).toBe(await seatsOf(target.organization));
  });
});

describe('使用量は人数と容量の合計の2値だけ', () => {
  test('seats_used は member-list の seats.used、attachment_used_bytes は容量の合計と一致する', async () => {
    const target = await createTarget();
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      name: '閉じた架空の場',
      closed_at: AT,
    });
    await createAttachment(target.organization, target.workspace.id, target.admin.userId!, { size_bytes: 17 });
    await createAttachment(target.organization, closed.id, target.admin.userId!, { size_bytes: 23 });
    const orgWiki = await addWikiPage(target.organization, null, target.admin.userId!);
    const workspaceWiki = await addWikiPage(target.organization, target.workspace.id, target.admin.userId!);
    const { admin } = await withBilling(target.organization);

    const result = await summary(admin, target.organization);
    const members = await post(app, memberList, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(members.status).toBe(200);
    const seats = ((await members.json()) as OutputOf<typeof memberList>).seats;
    expect(result.usage.seats_used).toBe(seats?.used);
    expect(result.usage.seats_used).toBe(await seatsOf(target.organization));

    expect(result.usage.attachment_used_bytes).toBe(17 + 23 + orgWiki + workspaceWiki);
    expect(result.usage.attachment_used_bytes).toBe(await storageBytesOf(target.organization));
    const info = await post(app, organizationInfo, {
      slug: target.slug,
      token: target.admin.token,
      body: { include_storage: true },
    });
    expect(info.status).toBe(200);
    expect(((await info.json()) as OutputOf<typeof organizationInfo>).storage?.used_bytes).toBe(
      result.usage.attachment_used_bytes,
    );
  });

  test('請求専用の担当者を足しても人数に数えない', async () => {
    const target = await createTarget();
    const first = await withBilling(target.organization);
    const before = (await summary(first.admin, target.organization)).usage.seats_used;
    const extra = await createPerson();
    const invitation = await ok(first.admin, billingAdminInvite, { slug: target.slug, account_id: extra.accountId });
    await ok(extra, billingInvitationRespond, { invitation_id: invitation.id, accept: true });
    expect((await summary(extra, target.organization)).usage.seats_used).toBe(before);
    expect(before).toBe(await seatsOf(target.organization));
  });

  test('応答のキーは決めた集合だけで、ワークスペース名・内訳・タスク数・最終利用日時を含まない', async () => {
    const target = await createTarget();
    await createWorkspace(target.organization, target.admin.userId!, { name: '架空の秘密の場' });
    await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await createAttachment(target.organization, target.workspace.id, target.admin.userId!, { size_bytes: 9 });
    const { admin } = await withBilling(target.organization);

    const uncontracted = await summary(admin, target.organization);
    expect(deepKeys(uncontracted).sort()).toEqual([...SUMMARY_KEYS].sort());

    await setContract(target.organization, { plan: 'team', billing_interval: 'monthly' });
    const response = await summaryResponse(admin, target.slug);
    expect(response.status).toBe(200);
    const text = await response.text();
    const contracted = JSON.parse(text) as Summary;
    expect(deepKeys(contracted).sort()).toEqual([...SUMMARY_KEYS, ...CONTRACT_KEYS].sort());
    for (const key of ['workspaces', 'workspace', 'task_count', 'tasks', 'last_used_at', 'breakdown', 'name']) {
      expect(deepKeys(contracted).map((path) => path.split('.').at(-1))).not.toContain(key);
    }
    expect(text).not.toContain('架空の秘密の場');
    expect(text).not.toContain(target.workspace.id);
  });
});

describe('読む間に担当を外れたら返さない（ランタイム）', () => {
  // 組織の中の表（人数と容量）を読んだ直後に担当者の行を解除し、共通の DB で確かめ直して 404 にすることを見る
  test('組織の DB を読んだ直後に解除されると 404 で使用量を返さない', async () => {
    const target = await createTarget();
    await createAttachment(target.organization, target.workspace.id, target.admin.userId!, { size_bytes: 777 });
    const { admin, id } = await withBilling(target.organization);
    const organizationTable = /wiki_pages|"attachments"|"invitations"|"memberships"|"users"/;
    let raced = false;
    const race = async (sqls: readonly string[]) => {
      if (raced || !sqls.some((sql) => organizationTable.test(sql))) return;
      raced = true;
      await setStatus(id, 'revoked');
    };
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: (sql) => race([sql]),
      afterBatch: (sqls) => race(sqls),
    });
    const response = await summaryResponse(admin, target.slug, racing);
    expect(raced).toBe(true);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain('usage');
    expect(text).not.toContain('777');
  });

  test('担当を確かめた直後（組織の DB を読む前）に解除されても 404', async () => {
    const target = await createTarget();
    const { admin, id } = await withBilling(target.organization);
    let raced = false;
    const race = async (sqls: readonly string[]) => {
      if (raced || !sqls.some((sql) => sql.includes('billing_administrators'))) return;
      raced = true;
      await setStatus(id, 'revoked');
    };
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: (sql) => race([sql]),
      afterBatch: (sqls) => race(sqls),
    });
    const response = await summaryResponse(admin, target.slug, racing);
    expect(raced).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('usage');
  });
});

describe('担当組織の一覧の行（my-billing-organizations）', () => {
  test('各行は { slug, name, kind, plan, state } で、未契約は plan が null', async () => {
    const person = await createPerson();
    const contracted = await createOrganization({ name: '架空の契約組織' });
    await setContract(contracted, { plan: 'team', billing_interval: 'monthly' });
    const uncontracted = await createOrganization({ name: '架空の未契約組織' });
    await withBilling(contracted, person);
    await withBilling(uncontracted, person);
    const mine = await ok(person, myBillingOrganizations);
    expect(mine.organizations).toHaveLength(2);
    expect(mine.organizations).toContainEqual({
      slug: contracted.slug,
      name: '架空の契約組織',
      kind: 'team',
      plan: 'team',
      state: 'active',
    });
    expect(mine.organizations).toContainEqual({
      slug: uncontracted.slug,
      name: '架空の未契約組織',
      kind: 'team',
      plan: null,
      state: 'active',
    });
    for (const row of mine.organizations) {
      expect(Object.keys(row).sort()).toEqual(['kind', 'name', 'plan', 'slug', 'state']);
    }
  });

  test('一時停止・解約で停止（予定日を過ぎた後も）の担当組織が、その状態で一覧に出る', async () => {
    const person = await createPerson();
    const suspended = await createOrganization();
    const cancelled = await createOrganization();
    const due = await createOrganization();
    for (const organization of [suspended, cancelled, due]) await withBilling(organization, person);
    await updateOrganization(suspended, { suspended_at: '2026-11-01T00:00:00.000Z' });
    await updateOrganization(cancelled, { suspended_at: '2026-11-01T00:00:00.000Z', purge_on: '2099-12-31' });
    await updateOrganization(due, { suspended_at: '2020-01-01T00:00:00.000Z', purge_on: '2020-02-01' });
    const rows = (await ok(person, myBillingOrganizations)).organizations;
    const stateOf = (organization: OrganizationFixture) => rows.find((row) => row.slug === organization.slug)?.state;
    expect(stateOf(suspended)).toBe('suspended');
    expect(stateOf(cancelled)).toBe('cancelled');
    expect(stateOf(due)).toBe('cancelled');
  });

  test('自分用の組織は kind personal で出る', async () => {
    const target = await createPersonalTarget();
    await setContract(target.organization, { plan: 'personal', billing_interval: 'monthly' });
    const { admin } = await withBilling(target.organization);
    expect((await ok(admin, myBillingOrganizations)).organizations).toEqual([
      { slug: target.slug, name: target.organization.name, kind: 'personal', plan: 'personal', state: 'active' },
    ]);
  });

  test('未承諾の指名は organizations に出ず、invitations の行は { id, slug, name } のまま', async () => {
    const organization = await createOrganization();
    const person = await createPerson();
    const invitation = await ok(await getOperator(), operatorBillingAdminInvite, {
      slug: organization.slug,
      account_id: person.accountId,
    });
    const mine = await ok(person, myBillingOrganizations);
    expect(mine.organizations).toEqual([]);
    expect(mine.invitations).toEqual([{ id: invitation.id, slug: organization.slug, name: organization.name }]);
  });
});
