import { z } from 'zod';
import { defineOperation } from '../define.ts';
import { connectionIdInput, connectionSchema } from './connection.ts';

// 接続を止める。登録した本人は自分の接続を、リーダーと管理者は同じワークスペースの他のメンバーの接続を止められる
// （docs/requirements.md の「取り込み」）。止める理由は、本人が止めたら owner、ほかの人が止めたら leader。
// 止まっていない接続と、本人が認証情報で再開できる理由（auth_failed、member_left、user_disabled）で止まった接続は、理由を owner か leader にして
// 再開しない停止にする。それ以外の理由（owner、leader、workspace_closed）で止まった接続は理由を書き換えず、そのまま返す。
// 止めた接続は同期されず、本人が新しい認証情報を保存しても再開しない。取り込む範囲は変えない。
// 権限が無ければ 403、見つからない接続（別の組織、別のワークスペース、削除済み）は 404、閉じたワークスペースは 409 の workspace_closed
export const connectionStop = defineOperation({
  name: 'connection-stop',
  description:
    '接続を止める。登録した本人と、ワークスペースのリーダー、管理者だけ。止めた接続は同期せず、認証情報を保存しても再開しない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: connectionIdInput,
  output: z.object({ connection: connectionSchema }),
});
