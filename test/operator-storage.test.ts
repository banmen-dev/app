import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  organizationPlanUpdate,
  organizationStorageUpdate,
  listOrganizations,
} from '../src/shared/operations/operator/index.ts';
import { organizationHistory } from '../src/shared/operations/organization/organization-history.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { createAttachment, createOrganization, createTask, AT } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, getOperator, testEnv, withNewSession, OPERATOR_LOGIN_ID } from './operations/world.ts';

const app = createApp(implementedOperations);
const GIB = 1024 ** 3;
type Contract = OutputOf<typeof organizationStorageUpdate>['contract'];
const token = async () => (await withNewSession(await getOperator())).token;
afterEach(() => vi.restoreAllMocks());
async function rows(id: string) {
  const db = commonDb(env);
  return {
    organization: await db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', id))),
    contract: await db.first(
      db.statement((q) => q.selectFrom('organization_contracts').selectAll().where('organization_id', '=', id)),
    ),
  };
}
async function setup(plan: 'team' | 'business' = 'team') {
  const organization = await createOrganization();
  const operator = await token();
  const response = await post(app, organizationPlanUpdate, {
    token: operator,
    body: { slug: organization.slug, plan, billing_interval: 'monthly', expected: null },
  });
  expect(response.status).toBe(200);
  const { contract } = (await response.json()) as OutputOf<typeof organizationPlanUpdate>;
  return { organization, operator, contract };
}
async function update(slug: string, operator: string, expected: Contract | null, ten = 0, fifty = 0, customEnv?: Env) {
  return post(app, organizationStorageUpdate, {
    token: operator,
    env: customEnv,
    body: { slug, billing_interval: 'monthly', extra_10gb_units: ten, extra_50gb_units: fifty, expected },
  });
}

describe('追加容量の設定', () => {
  test.each([
    ['team', 0, 1, 80],
    ['business', 2, 1, 170],
  ] as const)('%s の容量を口数に応じて増やし、一覧にも出す', async (plan, ten, fifty, quota) => {
    const { organization, operator, contract } = await setup(plan);
    const response = await update(organization.slug, operator, contract, ten, fifty);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attachment_quota_bytes: quota * GIB,
      member_limit: plan === 'team' ? 15 : 50,
    });
    expect((await rows(organization.id)).contract).toMatchObject({ extra_10gb_units: ten, extra_50gb_units: fifty });
    const listed = (await (await post(app, listOrganizations, { token: operator })).json()) as OutputOf<
      typeof listOrganizations
    >;
    expect(listed.organizations.find((row) => row.slug === organization.slug)).toMatchObject({
      attachment_quota_bytes: quota * GIB,
      contract: { extra_10gb_units: ten, extra_50gb_units: fifty },
    });
  });

  test('自分用に契約を作って11GBにし、人数と種類は保持する。0口でも契約は残る', async () => {
    const organization = await createOrganization({ kind: 'personal', member_limit: 1, attachment_quota_bytes: GIB });
    const operator = await token();
    const first = await update(organization.slug, operator, null, 1);
    expect(first.status).toBe(200);
    const output = (await first.json()) as OutputOf<typeof organizationStorageUpdate>;
    expect(output).toMatchObject({ attachment_quota_bytes: 11 * GIB, member_limit: 1, contract: { plan: 'personal' } });
    expect((await rows(organization.id)).organization).toMatchObject({ kind: 'personal', member_limit: 1 });
    expect((await update(organization.slug, operator, output.contract)).status).toBe(200);
    expect(await rows(organization.id)).toMatchObject({
      organization: { attachment_quota_bytes: GIB, member_limit: 1 },
      contract: { plan: 'personal', extra_10gb_units: 0, extra_50gb_units: 0 },
    });
  });

  test('未契約のチーム用は先にプランを決めるよう断る', async () => {
    const organization = await createOrganization();
    const before = await rows(organization.id);
    const response = await update(organization.slug, await token(), null, 1);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'plan_required' } } });
    expect(await rows(organization.id)).toEqual(before);
  });

  test('増加で通知を戻し、減少は通知と既存ファイルを残す。人数、お試し、停止は変えない', async () => {
    const target = await createTarget();
    const operator = await token();
    const plan = await post(app, organizationPlanUpdate, {
      token: operator,
      body: { slug: target.slug, plan: 'team', billing_interval: 'monthly', expected: null },
    });
    const { contract } = (await plan.json()) as OutputOf<typeof organizationPlanUpdate>;
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({
            attachment_quota_warned_at: AT,
            attachment_quota_warning_pending_at: AT,
            suspended_at: AT,
            trial_ends_on: '2999-12-31',
          })
          .where('id', '=', target.organization.id),
      ),
    ]);
    const added = await update(target.slug, operator, contract, 0, 1);
    const addedOutput = (await added.json()) as OutputOf<typeof organizationStorageUpdate>;
    expect(added.status).toBe(200);
    expect((await rows(target.organization.id)).organization).toMatchObject({
      attachment_quota_warned_at: null,
      attachment_quota_warning_pending_at: null,
      member_limit: 15,
      trial_ends_on: '2999-12-31',
      suspended_at: AT,
    });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const file = await createAttachment(target.organization, target.workspace.id, target.admin.userId!, {
      task_id: task.id,
      size_bytes: 40 * 1024 ** 2,
      attached_at: AT,
    });
    await db.batch([
      db.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_warned_at: AT }).where('id', '=', target.organization.id),
      ),
    ]);
    expect((await update(target.slug, operator, addedOutput.contract)).status).toBe(200);
    expect((await rows(target.organization.id)).organization).toMatchObject({
      attachment_quota_bytes: 30 * GIB,
      attachment_quota_warned_at: AT,
    });
    const organizationDb = orgDb(env, target.organization.verified);
    expect(
      await organizationDb.first(
        organizationDb.statement((q) => q.selectFrom('attachments').selectAll().where('id', '=', file.id)),
      ),
    ).toEqual(file);
  });

  test('使用量が減らした上限を超えても既存の添付ファイルを残す', async () => {
    const target = await createTarget();
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ kind: 'personal', member_limit: 1, attachment_quota_bytes: GIB })
          .where('id', '=', target.organization.id),
      ),
    ]);
    const operator = await token();
    const added = await update(target.slug, operator, null, 1);
    expect(added.status).toBe(200);
    const { contract } = (await added.json()) as OutputOf<typeof organizationStorageUpdate>;
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    for (let i = 0; i < 21; i++) {
      await createAttachment(target.organization, target.workspace.id, target.admin.userId!, {
        task_id: task.id,
        size_bytes: 50 * 1024 ** 2,
        attached_at: AT,
      });
    }
    const organizationDb = orgDb(env, target.organization.verified);
    const files = () =>
      organizationDb.rows(
        organizationDb.statement((q) =>
          q.selectFrom('attachments').selectAll().where('workspace_id', '=', target.workspace.id).orderBy('id'),
        ),
      );
    const before = await files();
    expect(before.reduce((sum, file) => sum + file.size_bytes, 0)).toBeGreaterThan(GIB);
    expect((await update(target.slug, operator, contract)).status).toBe(200);
    expect((await rows(target.organization.id)).organization?.attachment_quota_bytes).toBe(GIB);
    expect(await files()).toEqual(before);
  });

  test('古い口数のexpectedとプラン更新を断り、契約と容量を変えない', async () => {
    const { organization, operator, contract } = await setup();
    expect((await update(organization.slug, operator, contract, 1)).status).toBe(200);
    const before = await rows(organization.id);
    expect((await update(organization.slug, operator, contract, 2)).status).toBe(409);
    expect(
      (
        await post(app, organizationPlanUpdate, {
          token: operator,
          body: { slug: organization.slug, plan: 'business', billing_interval: 'yearly', expected: contract },
        })
      ).status,
    ).toBe(409);
    expect(await rows(organization.id)).toEqual(before);
  });

  test('読んだ後に別の運用者が口数を変えた場合も409で、容量だけを書かない', async () => {
    const { organization, operator, contract } = await setup();
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('"organization_contracts"') || !sql.includes('"trial_ends_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('organization_contracts')
              .set({ extra_10gb_units: 3 })
              .where('organization_id', '=', organization.id),
          ),
        ]);
      },
    });
    const before = (await rows(organization.id)).organization;
    expect((await update(organization.slug, operator, contract, 2, 0, racing)).status).toBe(409);
    expect(armed).toBe(false);
    expect((await rows(organization.id)).organization).toEqual(before);
    expect((await rows(organization.id)).contract?.extra_10gb_units).toBe(3);
  });

  test('運用者の履歴に前後の口数と支払い周期が出る', async () => {
    const target = await createTarget();
    const operator = await token();
    const plan = await post(app, organizationPlanUpdate, {
      token: operator,
      body: { slug: target.slug, plan: 'team', billing_interval: 'monthly', expected: null },
    });
    const { contract } = (await plan.json()) as OutputOf<typeof organizationPlanUpdate>;
    expect((await update(target.slug, operator, contract, 2, 1)).status).toBe(200);
    const history = (await (
      await post(app, organizationHistory, { token: target.admin.token, slug: target.slug })
    ).json()) as OutputOf<typeof organizationHistory>;
    expect(history.entries[0]).toMatchObject({
      actor: { kind: 'operator' },
      event: {
        kind: 'organization_storage_changed',
        from: { extra_10gb_units: 0, extra_50gb_units: 0, billing_interval: 'monthly' },
        to: { extra_10gb_units: 2, extra_50gb_units: 1, billing_interval: 'monthly' },
      },
    });
    const db = orgDb(env, target.organization.verified);
    const log = await db.first(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .selectAll()
          .where('organization_id', '=', target.organization.id)
          .where('operator', '=', OPERATOR_LOGIN_ID)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc'),
      ),
    );
    expect(JSON.parse(log!.changes_json)).toMatchObject({ extra_10gb_units: [0, 2], extra_50gb_units: [0, 1] });
  });

  test.each([-1, 101, 1.5])('口数%sは拒否する', async (units) => {
    const { organization, operator, contract } = await setup();
    expect((await update(organization.slug, operator, contract, units)).status).toBe(400);
    expect((await update(organization.slug, operator, contract, 0, units)).status).toBe(400);
    expect((await rows(organization.id)).contract).toMatchObject(contract);
  });

  test('上限の100口と年払いを設定でき、別の組織には影響せず、同じ設定は書かない', async () => {
    const organization = await createOrganization({ kind: 'personal', member_limit: 1, attachment_quota_bytes: GIB });
    const operator = await token();
    const contract = null;
    const other = await setup('business');
    const otherBefore = await rows(other.organization.id);
    const body = {
      slug: organization.slug,
      billing_interval: 'yearly' as const,
      extra_10gb_units: 100,
      extra_50gb_units: 100,
      expected: contract,
    };
    const response = await post(app, organizationStorageUpdate, { token: operator, body });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attachment_quota_bytes: 6001 * GIB,
      contract: { billing_interval: 'yearly' },
    });
    const before = await rows(organization.id);
    const organizationDb = orgDb(env, organization.verified);
    const logs = () =>
      organizationDb.rows(
        organizationDb.statement((q) =>
          q.selectFrom('change_logs').selectAll().where('organization_id', '=', organization.id).orderBy('id'),
        ),
      );
    const beforeLogs = await logs();
    expect((await post(app, organizationStorageUpdate, { token: operator, body })).status).toBe(200);
    expect(await rows(organization.id)).toEqual(before);
    expect(await logs()).toEqual(beforeLogs);
    expect(await rows(other.organization.id)).toEqual(otherBefore);
  });

  test.each([0, 1])('チーム用は周期だけでも口数と一緒でも変更できない（10GB %s口）', async (ten) => {
    const { organization, operator, contract } = await setup();
    const before = await rows(organization.id);
    const response = await post(app, organizationStorageUpdate, {
      token: operator,
      body: {
        slug: organization.slug,
        billing_interval: 'yearly',
        extra_10gb_units: ten,
        extra_50gb_units: 0,
        expected: contract,
      },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
    expect(await rows(organization.id)).toEqual(before);
  });

  test('未契約の自分用は0口でも契約を作り、履歴の前の周期は未契約として返す', async () => {
    const target = await createTarget();
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ kind: 'personal', member_limit: 1, attachment_quota_bytes: GIB })
          .where('id', '=', target.organization.id),
      ),
    ]);
    expect((await update(target.slug, await token(), null)).status).toBe(200);
    expect(await rows(target.organization.id)).toMatchObject({
      contract: { plan: 'personal', extra_10gb_units: 0, extra_50gb_units: 0 },
      organization: { attachment_quota_bytes: GIB },
    });
    const history = (await (
      await post(app, organizationHistory, { token: target.admin.token, slug: target.slug })
    ).json()) as OutputOf<typeof organizationHistory>;
    expect(history.entries[0]).toMatchObject({
      actor: { kind: 'operator' },
      event: {
        kind: 'organization_storage_changed',
        from: { extra_10gb_units: 0, extra_50gb_units: 0, billing_interval: null },
        to: { extra_10gb_units: 0, extra_50gb_units: 0, billing_interval: 'monthly' },
      },
    });
  });

  test('個別契約customは変更せず409を返す', async () => {
    const { organization, operator } = await setup();
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('organization_contracts').set({ plan: 'custom' }).where('organization_id', '=', organization.id),
      ),
    ]);
    const before = await rows(organization.id);
    expect(
      (
        await update(
          organization.slug,
          operator,
          { plan: 'custom', billing_interval: 'monthly', extra_10gb_units: 0, extra_50gb_units: 0 },
          1,
        )
      ).status,
    ).toBe(409);
    expect(await rows(organization.id)).toEqual(before);
  });

  test('読んだ後に上限が変更されたら契約と容量を更新しない', async () => {
    const { organization, operator, contract } = await setup();
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('"organization_contracts"') || !sql.includes('"trial_ends_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('organizations')
              .set({ attachment_quota_bytes: 31 * GIB })
              .where('id', '=', organization.id),
          ),
        ]);
      },
    });
    expect((await update(organization.slug, operator, contract, 1, 0, racing)).status).toBe(409);
    expect(armed).toBe(false);
    expect(await rows(organization.id)).toMatchObject({ contract, organization: { attachment_quota_bytes: 31 * GIB } });
  });

  test('履歴を書けなくても容量と契約は成功し、例外の詳細はログに含めない', async () => {
    const { organization, operator, contract } = await setup();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "change_logs"'))) throw new Error('secret SQL detail');
      },
    });
    expect((await update(organization.slug, operator, contract, 1, 0, failing)).status).toBe(200);
    expect(await rows(organization.id)).toMatchObject({
      contract: { extra_10gb_units: 1 },
      organization: { attachment_quota_bytes: 40 * GIB },
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = String(errorLog.mock.calls[0]![0]);
    expect(JSON.parse(logged)).toMatchObject({
      operation: 'organization-storage-update',
      organizationId: organization.id,
      error: 'Error',
      changes: { extra_10gb_units: [0, 1] },
    });
    expect(logged).not.toContain('secret SQL detail');
  });

  test('消す予定日を過ぎた組織と存在しない組織は変更できない', async () => {
    const organization = await createOrganization({ kind: 'personal', suspended_at: AT, purge_on: '2000-01-01' });
    const operator = await token();
    expect((await update(organization.slug, operator, null, 1)).status).toBe(409);
    expect((await update('missing-storage-org', operator, null, 1)).status).toBe(404);
  });
});
