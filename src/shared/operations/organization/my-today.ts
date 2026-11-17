import { z } from 'zod';
import { organizationKinds } from '../../organization-kind.ts';
import { defineOperation } from '../define.ts';
import { todayTaskSchema } from './today.ts';

// 全組織のダッシュボードの操作（my-today、my-workspaces、my-recent-activity）が行に添える組織
export const accountOrganizationSchema = z.object({
  slug: z.string(),
  name: z.string(),
  kind: z.enum(organizationKinds),
});
const organizationSchema = accountOrganizationSchema;
export const myToday = defineOperation({
  name: 'my-today',
  description: '入れる組織の自分の今日やることを返す',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({
    tasks: z.array(todayTaskSchema.extend({ organization: organizationSchema })),
    omitted_organizations: z.number().int().nonnegative(),
    failed_organizations: z.array(organizationSchema),
  }),
});
