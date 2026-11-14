import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

const slug = z.string().min(1).max(63);
export const operatorBillingAdminInvite = defineOperation({
  name: 'operator-billing-admin-invite',
  description: '運用者が最初の請求管理者を指名する',
  mode: 'write',
  permission: 'operator',
  cookieOnly: true,
  input: z.object({ slug, account_id: idSchema }),
  output: z.object({ id: z.string() }),
});
