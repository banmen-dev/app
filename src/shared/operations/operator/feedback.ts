import { z } from 'zod';
import { defineOperation } from '../define.ts';

// フィードバック（Issue #1550）の閲覧の口。運用者だけが、利用者が自分で送った文、送った画面の URL、送った人のアカウントの ID、画像を見る。
// 組織の中のデータではなく、送られた分だけ（docs/requirements.md の「組織と運用者」の例外、「機能」の「フィードバック」）。
// 表は持たず、R2 の `feedback/<フィードバックの ID>/meta.json` を読む。消えた（ライフサイクルの規則の 180 日）ものと、
// 存在しない ID は同じ 404

// フィードバックの ID と画像の ID は UUID。形が違えば R2 を引かずに 404 にする
export const FEEDBACK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 画像を返す操作のパスの id。`<フィードバックの ID>.<画像の ID>`（画像のキーは `feedback/<フィードバックの ID>/<画像の ID>`）
export const FEEDBACK_IMAGE_REF_PATTERN = new RegExp(
  `^(${FEEDBACK_ID_PATTERN.source.slice(1, -1)})\\.(${FEEDBACK_ID_PATTERN.source.slice(1, -1)})$`,
);
// パスの id は上の2つの UUID と区切りの1字。長い値を R2 に引く前に 400 で止める
const FEEDBACK_REF_MAX_LENGTH = 36 + 1 + 36;

export const feedbackImageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;

export function feedbackImageRef(feedbackId: string, imageId: string): string {
  return `${feedbackId}.${imageId}`;
}

export const operatorFeedback = defineOperation({
  name: 'operator-feedback',
  description:
    'フィードバックの文、送った画面の URL と route ID、送った人のアカウントの ID、画像の一覧（ID、種類、大きさ）、送った日時を、フィードバックの ID で返す。見つからない、または消えた（180 日）ときは 404',
  mode: 'read',
  permission: 'operator',
  input: z.object({ id: z.string().max(FEEDBACK_REF_MAX_LENGTH) }),
  output: z.object({
    feedback_id: z.string(),
    // 送った人のアカウントの ID（accounts.id）。組織ごとの users.id ではない
    account_id: z.string(),
    // オリジンとパスだけ。招待と認証の画面から送られたときは null
    url: z.string().nullable(),
    route_id: z.string().nullable(),
    text: z.string(),
    images: z.array(z.object({ id: z.string(), content_type: z.enum(feedbackImageTypes), bytes: z.number().int() })),
    submitted_at: z.string(),
  }),
});

// 画像のバイトをダウンロードとして返す。パスの id は feedbackImageRef の形。種類は meta.json の検証済みの値を使う
export const operatorFeedbackImage = defineOperation({
  name: 'operator-feedback-image',
  description: 'フィードバックに添えた画像を、フィードバックの ID と画像の ID で、ダウンロードとして返す',
  mode: 'read',
  permission: 'operator',
  response: 'binary',
  input: z.object({ id: z.string().max(FEEDBACK_REF_MAX_LENGTH) }),
  output: z.instanceof(Response),
});
