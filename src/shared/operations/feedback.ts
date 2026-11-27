import { z } from 'zod';
import { defineOperation } from './define.ts';

// / または、静的な区分や角括弧に入ったパラメーター名を / でつないだ形。照合はサーバーで行う。
const routeIdPattern = /^(?:\/|(?:\/(?:[A-Za-z0-9_-]+|\[[A-Za-z][A-Za-z0-9_]*\]))+)$/;
// URL が補正する空白、バックスラッシュ、空のユーザー情報も入力では受け付けない。
const absolutePageUrlPattern = /^https?:\/\/[^/\\\s@?#]+(?:[/?#][^\\\s]*)?$/i;

export const feedbackSubmit = defineOperation({
  name: 'feedback-submit',
  description: '画面から文だけのフィードバックを送る。本文は公開の Issue に載る',
  mode: 'write',
  permission: 'login',
  rateLimit: { max: 10, windowSeconds: 60 * 60 },
  // 5,000字と URL を JSON の Unicode エスケープで送っても収まる。
  maxBodyBytes: 128 * 1024,
  input: z.object({
    text: z.string(),
    route_id: z.string().max(160).regex(routeIdPattern),
    url: z.string().max(8192).regex(absolutePageUrlPattern),
  }),
  output: z.object({ feedback_id: z.uuidv7() }),
});
