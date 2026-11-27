// フィードバックに添えた画像とメタ情報の R2 への置き方（Issue #1556。docs/requirements.md の「フィードバック」、
// docs/data-model.md の「R2 のキー」）。キーは `feedback/<フィードバックの ID>/<画像の ID>` と `feedback/<フィードバックの ID>/meta.json`。
// 組織の接頭辞の外に置き、消すのは R2 のライフサイクルの規則（180 日）だけ。
// 画像の種類と大きさは送った人の申告ではなく、中身のバイトで決める（src/server/avatars/image.ts）。
// ログには本文、URL、アカウントの ID、キーを出さず、消せなかった件数だけを出す（src/server/avatars/remove.ts と同じ）。
import {
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_IMAGE_MAX_SIDE,
} from '../../shared/operations/feedback.ts';
import { readAvatarImage } from '../avatars/image.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';

export type FeedbackImage = {
  id: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
};

// meta.json の中身。運用者だけが見る（公開の Issue には載せない）
export type FeedbackMeta = {
  feedbackId: string;
  accountId: string;
  // オリジンとパスだけ。招待と認証の画面からの送信では null
  url: string | null;
  // 既知の route ID。合わなければ null
  routeId: string | null;
  // Issue に載せるのと同じ、正規化した文
  text: string;
  submittedAt: Date;
};

const IMAGE_PROBLEM = 'invalid_input';

function imageError(message: 'too_many_images' | 'image_too_large' | 'image_unsupported'): ApiError {
  return new ApiError(400, IMAGE_PROBLEM, [{ path: 'files', code: 'custom', message }]);
}

// 送られたファイルを画像として確かめる。1つでも合わなければ断り、R2 には何も置かない（呼ぶ側は確かめた後にだけ置く）。
// 形式は PNG、JPEG、WebP の静止画だけ。SVG、HTML、動く画像、ヘッダーを読めないものは断る。
// File の type と name は送った人の申告なので使わない
export async function readFeedbackImages(files: readonly File[], at: Date): Promise<FeedbackImage[]> {
  if (files.length > FEEDBACK_IMAGE_MAX_COUNT) throw imageError('too_many_images');
  for (const file of files) {
    if (file.size > FEEDBACK_IMAGE_MAX_BYTES) throw imageError('image_too_large');
  }
  const images: FeedbackImage[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > FEEDBACK_IMAGE_MAX_BYTES) throw imageError('image_too_large');
    const image = readAvatarImage(bytes);
    if (image === null || image.animated) throw imageError('image_unsupported');
    if (image.width > FEEDBACK_IMAGE_MAX_SIDE || image.height > FEEDBACK_IMAGE_MAX_SIDE) {
      throw imageError('image_too_large');
    }
    images.push({ id: uuidv7(at), contentType: image.contentType, bytes });
  }
  return images;
}

export function feedbackObjectKeys(feedbackId: string, images: readonly FeedbackImage[]): string[] {
  return [...images.map((image) => `feedback/${feedbackId}/${image.id}`), `feedback/${feedbackId}/meta.json`];
}

// 画像を置いてから meta.json を置く（meta.json があれば画像もある）。どれかの書き込みに失敗したら false
// （呼ぶ側が、置けた分を消す）。例外の文はキーを含みうるので返さない
export async function putFeedbackObjects(
  bucket: Pick<R2Bucket, 'put'>,
  meta: FeedbackMeta,
  images: readonly FeedbackImage[],
): Promise<boolean> {
  const prefix = `feedback/${meta.feedbackId}`;
  try {
    await Promise.all(
      images.map((image) =>
        bucket.put(`${prefix}/${image.id}`, image.bytes, { httpMetadata: { contentType: image.contentType } }),
      ),
    );
    const body = JSON.stringify({
      feedback_id: meta.feedbackId,
      account_id: meta.accountId,
      url: meta.url,
      route_id: meta.routeId,
      text: meta.text,
      images: images.map((image) => ({ id: image.id, content_type: image.contentType, bytes: image.bytes.byteLength })),
      submitted_at: meta.submittedAt.toISOString(),
    });
    await bucket.put(`${prefix}/meta.json`, body, { httpMetadata: { contentType: 'application/json' } });
    return true;
  } catch {
    return false;
  }
}

// 起票されていないと分かった後に、置いた R2 を消す。失敗しても操作の結果は変えず、消せなかった件数だけをログに出す
// （消せなかった分は、ライフサイクルの規則が消す）
export async function removeFeedbackObjects(bucket: Pick<R2Bucket, 'delete'>, keys: readonly string[]): Promise<void> {
  try {
    await bucket.delete([...keys]);
  } catch {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        operation: 'feedback-submit',
        reason: 'フィードバックの R2 のファイルを消せなかった',
        count: keys.length,
      }),
    );
  }
}
