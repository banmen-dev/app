import { z } from 'zod';
import { defineOperation } from '../define.ts';
import { connectionCredentialSchema, connectionIdInput, connectionNameSchema, connectionSchema } from './connection.ts';

export const connectionUpdate = defineOperation({
  name: 'connection-update',
  description:
    '本人の接続の表示名と認証情報を更新する。認証の失敗、離脱、無効化で止まった接続は、本人がそのワークスペースの今のメンバーなら認証情報の更新で再開する。リーダーや本人の操作で止めた接続は再開しない（ワークスペースを閉じても接続は止まらず、閉じている間は更新も 409 の workspace_closed）',
  mode: 'write',
  permission: 'member',
  workspace: true,
  // 認証情報の検証で取り込み元に問い合わせる。入力を読む前に数えるため、表示名だけの保存も同じ枠を使う。
  rateLimit: { max: 10, windowSeconds: 600 },
  input: connectionIdInput.extend({
    name: connectionNameSchema,
    credential: connectionCredentialSchema.optional(),
  }),
  output: z.object({ connection: connectionSchema }),
});
