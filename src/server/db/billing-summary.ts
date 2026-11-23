// 請求管理者に見せる、担当組織1つの契約・上限・利用の状態と、使用量（人数と容量の合計の2値だけ）。
// 承諾済みの担当者でなければ、存在しない組織と同じ 404
import { sql } from 'kysely';
import type { z } from 'zod';
import { isPurgeDue } from '../../shared/operations/operator/organization-suspend.ts';
import { billingOrganizationState, type billingOrganizationSummary } from '../../shared/operations/billing.ts';
import type { OrganizationKind } from '../../shared/organization-kind.ts';
import type { BillingInterval, OrganizationPlan } from '../../shared/organization-plan.ts';
import { ApiError } from '../errors.ts';
import { commonDb, orgDb, type CommonDb } from './entries.ts';
import { seatHoldersOf } from './seats.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';
import { organizationStorageBytes } from './wiki.ts';

// この人が今も承諾済みの担当者である組織の slug 条件。読む文と確かめ直す文の両方に、同じ式を置く
const activeActorOf = (slug: string, accountId: string) => sql<boolean>`EXISTS (
  SELECT 1 FROM billing_administrators AS actor
  WHERE actor.organization_id = organizations.id AND actor.account_id = ${accountId} AND actor.status = 'active'
  AND organizations.slug = ${slug}
)`;

// 共通の表（organizations と organization_contracts、担当者）だけを1つの文で読む。担当外は undefined
async function readOrganization(common: CommonDb, slug: string, accountId: string) {
  return common.first(
    common.statement((q) =>
      q
        .selectFrom('organizations')
        .leftJoin('organization_contracts', 'organization_contracts.organization_id', 'organizations.id')
        .select([
          'organizations.id',
          'organizations.kind',
          'organizations.suspended_at',
          'organizations.purge_on',
          'organizations.trial_ends_on',
          'organizations.member_limit',
          'organizations.attachment_quota_bytes',
          'organization_contracts.plan',
          'organization_contracts.billing_interval',
          'organization_contracts.extra_10gb_units',
          'organization_contracts.extra_50gb_units',
          'organization_contracts.custom_member_limit',
          'organization_contracts.custom_attachment_quota_bytes',
        ])
        .where(activeActorOf(slug, accountId)),
    ),
  );
}

// 数えた後に、共通の DB で今も承諾済みの担当者かを確かめ直す（読む間に解除されていれば使用量を返さない）
async function stillActive(common: CommonDb, organizationId: string, slug: string, accountId: string) {
  const row = await common.first(
    common.statement((q) =>
      q
        .selectFrom('organizations')
        .select('organizations.id')
        .where('organizations.id', '=', organizationId)
        .where(activeActorOf(slug, accountId)),
    ),
  );
  return row !== undefined;
}

export async function readBillingOrganizationSummary(
  env: Env,
  slug: string,
  accountId: string,
  at: Date,
): Promise<z.input<typeof billingOrganizationSummary.output>> {
  const common = commonDb(env);
  const organization = await readOrganization(common, slug, accountId);
  if (organization === undefined) throw new ApiError(404, 'not_found');
  // 共通の DB で確かめた ID から、この関数の中だけで組織の入口を作る。入口は外へ出さない。
  // 共通の表とは結合せず、別の文で人数と容量の合計の2値だけを読む
  const db = orgDb(env, issueVerifiedOrganization(organization.id));
  const [seats, storage] = await Promise.all([
    seatHoldersOf(db, at),
    db.first(db.statement((q) => q.selectNoFrom(organizationStorageBytes(db).as('bytes')))),
  ]);
  if (!(await stillActive(common, organization.id, slug, accountId))) throw new ApiError(404, 'not_found');
  const suspended = organization.suspended_at !== null;
  return {
    // 列の CHECK が守る値
    kind: organization.kind as OrganizationKind,
    state: billingOrganizationState(organization),
    // 消す予定日は停止中だけ返す（停止していないのに残った不整合な行で、利用中の組織に消去予定を出さない）
    purge_on: suspended ? organization.purge_on : null,
    purge_due: suspended && isPurgeDue(organization.purge_on, at),
    trial_ends_on: organization.trial_ends_on,
    contract:
      organization.plan === null || organization.billing_interval === null
        ? null
        : {
            // 列の CHECK が守る値
            plan: organization.plan as OrganizationPlan,
            billing_interval: organization.billing_interval as BillingInterval,
            extra_10gb_units: organization.extra_10gb_units ?? 0,
            extra_50gb_units: organization.extra_50gb_units ?? 0,
            custom_member_limit: organization.custom_member_limit,
            custom_attachment_quota_bytes: organization.custom_attachment_quota_bytes,
          },
    member_limit: organization.member_limit,
    attachment_quota_bytes: organization.attachment_quota_bytes,
    usage: { seats_used: seats.size, attachment_used_bytes: Number(storage?.bytes ?? 0) },
  };
}
