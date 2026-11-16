import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { sprintNameTemplateSchema } from '../../sprint.ts';
import { defineOperation } from '../define.ts';

export const workspaceSprintNamingUpdate = defineOperation({
  name: 'workspace-sprint-naming-update',
  description: 'スプリントの命名ルールと次の番号を変え、変更の履歴に残す。空ならルール無し',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    sprint_name_template: sprintNameTemplateSchema,
    sprint_number_next: z.number().int().min(1),
  }),
  output: z.object({ sprint_name_template: z.string().nullable(), sprint_number_next: z.number().int() }),
});
