// フィードバックの閲覧の処理（定義は src/shared/operations/operator/feedback.ts。Issue #1557）。
// 運用者は、送られたフィードバックの文、URL、アカウントの ID、画像だけを見られる（組織の中のデータは見られない）
import {
  FEEDBACK_IMAGE_REF_PATTERN,
  operatorFeedback,
  operatorFeedbackImage,
} from '../../shared/operations/operator/index.ts';
import { ApiError } from '../errors.ts';
import { feedbackKey } from '../feedback/read.ts';
import { implement } from './implement.ts';

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

export const operatorFeedbackOperation = implement(operatorFeedback, async ({ input, operator }) => {
  const feedback = await operator.readFeedback(input.id);
  if (feedback === undefined) throw new ApiError(404, 'not_found');
  return feedback;
});

export const operatorFeedbackImageOperation = implement(
  operatorFeedbackImage,
  async ({ input, operator, download }) => {
    const match = FEEDBACK_IMAGE_REF_PATTERN.exec(input.id);
    if (match === null) throw new ApiError(404, 'not_found');
    const [, feedbackId, imageId] = match;
    if (feedbackId === undefined || imageId === undefined) throw new ApiError(404, 'not_found');
    // 画像の ID が meta.json の一覧に無ければ、R2 を引かずに 404（キーは検証した2つの UUID だけから組む）
    const feedback = await operator.readFeedback(feedbackId);
    const image = feedback?.images.find((item) => item.id === imageId);
    if (image === undefined) throw new ApiError(404, 'not_found');
    const key = feedbackKey(feedbackId, imageId);
    // URL を直接開いたときは描かずに保存させる。attachment は <img> の読み込みには効かないので、運用者の画面は描ける。種類は meta.json の値
    const headers = new Headers({
      'Content-Type': image.content_type,
      // 画像の ID は検証済みの UUID なのでヘッダーに入れてよい。拡張子は meta.json の種類から決める
      'Content-Disposition': `attachment; filename="feedback-${imageId}.${EXTENSIONS[image.content_type]}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    if (download.head) {
      const object = await download.bucket.head(key);
      if (object === null) throw new ApiError(404, 'not_found');
      headers.set('Content-Length', String(object.size));
      return new Response(null, { headers });
    }
    const object = await download.bucket.get(key);
    if (object === null) throw new ApiError(404, 'not_found');
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  },
);
