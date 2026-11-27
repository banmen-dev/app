// フィードバックの閲覧（Issue #1557）。R2 の `feedback/<フィードバックの ID>/meta.json` を読んで検証する。
// キーは、検証した UUID から決まった形で組む（組織の接頭辞の下の添付は読めない）。
// 種類と大きさは、R2 のメタ情報ではなく meta.json の検証済みの値を使う（置いたのはサーバーで、中身のバイトで決めた値）。
// 見つからない、消えた（ライフサイクルの規則の 180 日）、中身が壊れている、形が合わないものは undefined（呼ぶ側が 404 にする）。R2 自体の失敗は握らず 500 になる。
// 失敗のログに本文、URL、アカウントの ID、キーを出さない
import { z } from 'zod';
import { FEEDBACK_ID_PATTERN, feedbackImageTypes } from '../../shared/operations/operator/feedback.ts';

const uuid = z.string().regex(FEEDBACK_ID_PATTERN);

// putFeedbackObjects（store.ts）が書く形
const metaSchema = z.object({
  feedback_id: uuid,
  account_id: z.string().min(1),
  url: z.string().nullable(),
  route_id: z.string().nullable(),
  text: z.string(),
  images: z.array(z.object({ id: uuid, content_type: z.enum(feedbackImageTypes), bytes: z.number().int().min(0) })),
  submitted_at: z.string(),
});

export type FeedbackView = z.infer<typeof metaSchema>;

export function feedbackKey(feedbackId: string, name: string): string {
  return `feedback/${feedbackId}/${name}`;
}

export async function readFeedbackMeta(
  bucket: Pick<R2Bucket, 'get'>,
  feedbackId: string,
): Promise<FeedbackView | undefined> {
  if (!FEEDBACK_ID_PATTERN.test(feedbackId)) return undefined;
  const object = await bucket.get(feedbackKey(feedbackId, 'meta.json'));
  if (object === null) return undefined;
  let value: unknown;
  try {
    value = await object.json();
  } catch {
    return undefined;
  }
  const parsed = metaSchema.safeParse(value);
  // 別のフィードバックの meta.json を指すキーの取り違えも断る
  if (!parsed.success || parsed.data.feedback_id !== feedbackId) return undefined;
  return parsed.data;
}
