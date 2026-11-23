import { z } from 'zod';
import { idSchema } from '../id.ts';
import { organizationKinds } from '../organization-kind.ts';
import { organizationPlans } from '../organization-plan.ts';
import { defineOperation } from './define.ts';
import { organizationContract } from './operator/organization-plan-update.ts';

const slug = z.string().min(1).max(63);
const administrator = z.object({
  id: z.string(),
  account_id: z.string(),
  name: z.string(),
  status: z.enum(['pending', 'active']),
});
// 請求管理者に見せる組織の利用の状態。停止していなければ active、停止して消す予定日が空なら suspended、予定日があれば cancelled
export const billingOrganizationStates = ['active', 'suspended', 'cancelled'] as const;
// 利用の状態。停止していなければ active、停止して消す予定日が空なら suspended（一時的な停止）、あれば cancelled（解約で停止）。
// 一覧の行と選んだ組織の紙が同じ式を使う（運用者の一覧の suspended_at と purge_on と同じ境目）
export function billingOrganizationState(organization: {
  suspended_at: string | null;
  purge_on: string | null;
}): (typeof billingOrganizationStates)[number] {
  if (organization.suspended_at === null) return 'active';
  return organization.purge_on === null ? 'suspended' : 'cancelled';
}
export const myBillingOrganizations = defineOperation({
  name: 'my-billing-organizations',
  description: '自分が請求を担当する組織と届いた指名を返す',
  mode: 'read',
  permission: 'login',
  cookieOnly: true,
  input: z.object({}),
  output: z.object({
    account_id: z.string(),
    operator: z.boolean(),
    organizations: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        kind: z.enum(organizationKinds),
        // organization_contracts の行が無ければ null（未契約）
        plan: z.enum(organizationPlans).nullable(),
        state: z.enum(billingOrganizationStates),
      }),
    ),
    invitations: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
  }),
});
export const billingAdminList = defineOperation({
  name: 'billing-admin-list',
  description: '担当組織の請求管理者と権限の変更履歴を返す',
  mode: 'read',
  permission: 'login',
  cookieOnly: true,
  input: z.object({ slug }),
  output: z.object({
    administrators: z.array(administrator),
    events: z.array(
      z.object({
        id: z.string(),
        actor_account_id: z.string(),
        actor_name: z.string().optional(),
        target_account_id: z.string(),
        target_name: z.string().optional(),
        action: z.enum(['invited', 'accepted', 'declined', 'removed']),
        created_at: z.string(),
      }),
    ),
  }),
});
// 承諾済みの担当組織の契約、今の上限、利用の状態と、使用量（人数と容量の合計の2値だけ）。担当外は存在しない組織と同じ 404
export const billingOrganizationSummary = defineOperation({
  name: 'billing-organization-summary',
  description: '担当組織の契約、今の上限、利用の状態と、人数と容量の使用量を返す',
  // 開くたびに組織全体の人数と容量（Wiki の全版と添付）を数える重い読み取りなので、Wiki の検索と同じ枠を付ける
  rateLimit: { max: 30, windowSeconds: 60 },
  mode: 'read',
  permission: 'login',
  cookieOnly: true,
  input: z.object({ slug }),
  output: z.object({
    kind: z.enum(organizationKinds),
    state: z.enum(billingOrganizationStates),
    purge_on: z.string().nullable(),
    purge_due: z.boolean(),
    trial_ends_on: z.string().nullable(),
    contract: organizationContract.nullable(),
    member_limit: z.number().int(),
    attachment_quota_bytes: z.number().int(),
    usage: z.object({ seats_used: z.number().int(), attachment_used_bytes: z.number().int() }),
  }),
});
export const billingAdminInvite = defineOperation({
  name: 'billing-admin-invite',
  description: '担当組織の請求管理者を指名する',
  mode: 'write',
  rateLimit: { max: 30, windowSeconds: 600 },
  permission: 'login',
  cookieOnly: true,
  input: z.object({ slug, account_id: idSchema }),
  output: z.object({ id: z.string() }),
});
export const billingInvitationRespond = defineOperation({
  name: 'billing-invitation-respond',
  description: '自分宛ての請求管理者の指名を承諾または辞退する',
  mode: 'write',
  rateLimit: { max: 30, windowSeconds: 600 },
  permission: 'login',
  cookieOnly: true,
  input: z.object({ invitation_id: idSchema, accept: z.boolean() }),
  output: z.object({}),
});
export const billingAdminRemove = defineOperation({
  name: 'billing-admin-remove',
  description: '担当組織の請求管理者の指名や権限を解除する',
  mode: 'write',
  rateLimit: { max: 30, windowSeconds: 600 },
  permission: 'login',
  cookieOnly: true,
  input: z.object({ slug, administrator_id: idSchema }),
  output: z.object({}),
});
export { operatorBillingAdminInvite } from './operator/billing-admin-invite.ts';
