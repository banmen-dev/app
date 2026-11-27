// フィードバックの閲覧のテストが R2 に置く、送られたフィードバックの見本。本体の置き方（src/server/feedback/store.ts）で置く
import { env } from 'cloudflare:workers';
import { putFeedbackObjects, type FeedbackImage } from '../../src/server/feedback/store.ts';
import { uuidv7 } from '../../src/server/uuid.ts';
import { pngImage } from '../avatar-images.ts';

export type StoredFeedback = {
  feedbackId: string;
  accountId: string;
  imageIds: string[];
  imageBytes: Uint8Array;
  text: string;
  url: string | null;
};

export async function storeFeedback(
  options: { images?: number; text?: string; url?: string | null; accountId?: string } = {},
): Promise<StoredFeedback> {
  const feedbackId = uuidv7();
  const accountId = options.accountId ?? uuidv7();
  const text = options.text ?? '画面の見出しが切れています';
  const url = options.url === undefined ? 'https://banmen.test/aoba/w/ws/board' : options.url;
  const imageBytes = pngImage(2, 2);
  const images: FeedbackImage[] = Array.from({ length: options.images ?? 1 }, () => ({
    id: uuidv7(),
    contentType: 'image/png',
    file: new Blob([imageBytes], { type: 'image/png' }),
  }));
  const stored = await putFeedbackObjects(
    env.ATTACHMENTS,
    {
      feedbackId,
      accountId,
      url,
      routeId: '/[slug]/w/[id]/board',
      text,
      submittedAt: new Date('2026-11-24T07:00:00Z'),
    },
    images,
  );
  if (!stored) throw new Error('フィードバックを R2 に置けなかった');
  return { feedbackId, accountId, imageIds: images.map((image) => image.id), imageBytes, text, url };
}
