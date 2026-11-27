import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import {
  CONNECTION_SOURCE_STATUS_MAX_LENGTH,
  CONNECTION_STATUS_MAPPINGS_MAX,
  connectionIdInput,
  connectionSchema,
} from './connection.ts';

// 取り込み元の状態から列への対応と、取り込み元の期限を無視する設定を置き換える。登録した本人だけ。
// 完了の列と、ワークスペースに無い列は 400（details の code は column_done、column_unknown）。
// 期限を無視する設定にしたら、取り込み済みの取り込み元の期限も同じバッチで空にする。閉じたワークスペースでは 409 の workspace_closed
export const connectionMappingSave = defineOperation({
  name: 'connection-mapping-save',
  description:
    '接続の、取り込み元の状態から列への対応（完了の列は選べない）と、取り込み元の期限を無視する設定を置き換える。登録した本人だけ',
  mode: 'write',
  permission: 'member',
  workspace: true,
  rateLimit: { max: 30, windowSeconds: 300 },
  input: connectionIdInput.extend({
    mappings: z
      .array(
        z.object({
          source_status: z.string().min(1).max(CONNECTION_SOURCE_STATUS_MAX_LENGTH),
          column_id: idSchema,
        }),
      )
      .max(CONNECTION_STATUS_MAPPINGS_MAX),
    ignore_source_due: z.boolean(),
  }),
  output: z.object({ connection: connectionSchema }),
});
