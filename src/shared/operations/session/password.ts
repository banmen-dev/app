import { z } from 'zod';
import { defineOperation } from '../define.ts';

export const passwordChange = defineOperation({
  name: 'password-change',
  description: '現在のパスワードを確かめて新しいパスワードに変え、今のセッション以外を失効させる',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  // パスワードのログインのメールアドレス枠と同じ回数を、操作とアカウントごとに数える。
  rateLimit: { max: 10, windowSeconds: 600 },
  maxBodyBytes: 8 * 1024,
  input: z.object({ current_password: z.string(), new_password: z.string() }).strict(),
  output: z.object({}),
});
