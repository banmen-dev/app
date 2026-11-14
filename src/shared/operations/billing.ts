import { z } from 'zod';
import { idSchema } from '../id.ts';
import { defineOperation } from './define.ts';

const slug = z.string().min(1).max(63);
const administrator = z.object({
  id: z.string(),
  account_id: z.string(),
  name: z.string(),
  status: z.enum(['pending', 'active']),
});
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
    organizations: z.array(z.object({ slug: z.string(), name: z.string() })),
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
        target_account_id: z.string(),
        action: z.enum(['invited', 'accepted', 'declined', 'removed']),
        created_at: z.string(),
      }),
    ),
  }),
});
export const billingAdminInvite = defineOperation({
  name: 'billing-admin-invite',
  description: '担当組織の請求管理者を指名する',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({ slug, account_id: idSchema }),
  output: z.object({ id: z.string() }),
});
export const billingInvitationRespond = defineOperation({
  name: 'billing-invitation-respond',
  description: '自分宛ての請求管理者の指名を承諾または辞退する',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({ invitation_id: idSchema, accept: z.boolean() }),
  output: z.object({}),
});
export const billingAdminRemove = defineOperation({
  name: 'billing-admin-remove',
  description: '担当組織の請求管理者の指名や権限を解除する',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({ slug, administrator_id: idSchema }),
  output: z.object({}),
});
export { operatorBillingAdminInvite } from './operator/billing-admin-invite.ts';
