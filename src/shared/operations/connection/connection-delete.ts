import { z } from 'zod';
import { defineOperation } from '../define.ts';
import { connectionIdInput } from './connection.ts';

// 接続を削除する（論理削除）。登録した本人と、ワークスペースのリーダー、管理者だけ（docs/requirements.md の「取り込み」）。
// 認証情報の列（暗号文、鍵の版、末尾4文字）と、認証情報に結んだ同期と照合の続きの位置を消す。取り込み済みのタスクと範囲は残す。
// 止まっている接続も消せる。権限が無ければ 403、見つからない接続（別の組織、別のワークスペース、削除済み）は 404、
// 閉じたワークスペースは 409 の workspace_closed
export const connectionDelete = defineOperation({
  name: 'connection-delete',
  description:
    '接続を削除し、保存した認証情報を消す。登録した本人と、ワークスペースのリーダー、管理者だけ。取り込み済みのタスクは残る',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: connectionIdInput,
  output: z.object({ connection_id: z.string() }),
});
