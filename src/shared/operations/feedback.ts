import { z } from 'zod';
import { defineOperation } from './define.ts';

// / または、静的な区分や角括弧に入ったパラメーター名を / でつないだ形。照合はサーバーで行う。
const routeIdPattern = /^(?:\/|(?:\/(?:[A-Za-z0-9_-]+|\[[A-Za-z][A-Za-z0-9_]*\]))+)$/;
// URL が補正する空白、バックスラッシュ、空のユーザー情報も入力では受け付けない。
const absolutePageUrlPattern = /^https?:\/\/[^/\\\s@?#]+(?:[/?#][^\\\s]*)?$/i;

// 添える画像（スクリーンショット）の上限。画面と操作で同じ値を使う。
export const FEEDBACK_IMAGE_MAX_COUNT = 3;
export const FEEDBACK_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
// 一辺の画素数の上限
export const FEEDBACK_IMAGE_MAX_SIDE = 8192;

// 本文の上限（字）。サーバーは見えない文字を除いた後のコードポイントで数え、画面も同じ数で送る前に確かめる
export const FEEDBACK_TEXT_MAX = 5000;

export const feedbackSubmit = defineOperation({
  name: 'feedback-submit',
  description: '画面から文と画像（3枚まで）のフィードバックを送る。文は公開の Issue に載り、画像は運用者だけが見る',
  mode: 'write',
  permission: 'login',
  body: 'multipart',
  rateLimit: { max: 10, windowSeconds: 60 * 60 },
  // 画像3枚（各 4MiB）に、5,000字と URL を JSON の Unicode エスケープで送った分（128KiB）と部分の見出しが収まる。
  maxBodyBytes: FEEDBACK_IMAGE_MAX_COUNT * FEEDBACK_IMAGE_MAX_BYTES + 256 * 1024,
  input: z.object({
    text: z.string(),
    route_id: z.string().max(160).regex(routeIdPattern),
    url: z.string().max(8192).regex(absolutePageUrlPattern),
  }),
  output: z.object({ feedback_id: z.uuidv7() }),
});
