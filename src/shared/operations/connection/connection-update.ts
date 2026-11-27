import { z } from 'zod';
import { defineOperation } from '../define.ts';
import { connectionCredentialSchema, connectionIdInput, connectionNameSchema, connectionSchema } from './connection.ts';

export const connectionUpdate = defineOperation({
  name: 'connection-update',
  description: '本人の接続の表示名と認証情報を更新する。認証の失敗で止まった接続は認証情報の更新で再開する',
  mode: 'write',
  permission: 'member',
  workspace: true,
  // 認証情報を更新するときは取り込み元に問い合わせる
  rateLimit: { max: 10, windowSeconds: 600 },
  input: connectionIdInput.extend({
    name: connectionNameSchema,
    credential: connectionCredentialSchema.optional(),
  }),
  output: z.object({ connection: connectionSchema }),
});
