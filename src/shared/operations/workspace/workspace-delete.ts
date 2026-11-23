import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

export const workspaceDelete = defineOperation({
  name: 'workspace-delete',
  description: '終了済みのワークスペースを名前の確認を経て論理削除する',
  mode: 'write',
  permission: 'admin',
  workspace: true,
  allowClosed: true,
  cookieOnly: true,
  storage: 'attachments',
  input: z.object({ workspace_id: idSchema, confirm_name: z.string().min(1).max(100) }),
  output: z.object({ workspace_id: idSchema }),
});
