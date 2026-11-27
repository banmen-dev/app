import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { feedbackImageRef, operatorFeedback, operatorFeedbackImage } from '../src/shared/operations/operator/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { uuidv7 } from '../src/server/uuid.ts';
import { storeFeedback } from './feedback/stored.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, getOperator, testEnv, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations);
const operator = async () => (await withNewSession(await getOperator())).token;
const ordinary = async () => (await createPerson()).token;

describe('operator-feedback', () => {
  test('運用者は文、URL、アカウントの ID、画像の一覧を見られる', async () => {
    const stored = await storeFeedback({ images: 2 });
    const res = await post(app, operatorFeedback, { token: await operator(), body: { id: stored.feedbackId } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      feedback_id: stored.feedbackId,
      account_id: stored.accountId,
      url: stored.url,
      route_id: '/[slug]/w/[id]/board',
      text: stored.text,
      images: stored.imageIds.map((id) => ({ id, content_type: 'image/png', bytes: stored.imageBytes.byteLength })),
      submitted_at: '2026-11-24T07:00:00.000Z',
    });
  });

  test('招待と認証の画面から送られたフィードバックは URL が null', async () => {
    const stored = await storeFeedback({ url: null, images: 0 });
    const res = await post(app, operatorFeedback, { token: await operator(), body: { id: stored.feedbackId } });
    expect(await res.json()).toMatchObject({ url: null, images: [] });
  });

  test('運用者でない人は 403、ログインしていなければ 401', async () => {
    const stored = await storeFeedback();
    const forbidden = await post(app, operatorFeedback, { token: await ordinary(), body: { id: stored.feedbackId } });
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    const anonymous = await post(app, operatorFeedback, { body: { id: stored.feedbackId } });
    expect(anonymous.status).toBe(401);
  });

  test('存在しない ID、UUID でない値、消えた meta.json は 404', async () => {
    const stored = await storeFeedback();
    await env.ATTACHMENTS.delete(`feedback/${stored.feedbackId}/meta.json`);
    for (const id of [uuidv7(), 'not-a-uuid', stored.feedbackId, '../x', `${stored.feedbackId}/meta.json`]) {
      const res = await post(app, operatorFeedback, { token: await operator(), body: { id } });
      // 長すぎる値は R2 を引く前に 400、それ以外は 404
      expect([400, 404], id).toContain(res.status);
    }
  });

  test('壊れた meta.json と別のフィードバックの meta.json は 404', async () => {
    const broken = uuidv7();
    await env.ATTACHMENTS.put(`feedback/${broken}/meta.json`, '{broken');
    const mismatched = await storeFeedback();
    const other = uuidv7();
    const body = await (await env.ATTACHMENTS.get(`feedback/${mismatched.feedbackId}/meta.json`))!.text();
    await env.ATTACHMENTS.put(`feedback/${other}/meta.json`, body);
    for (const id of [broken, other]) {
      const res = await post(app, operatorFeedback, { token: await operator(), body: { id } });
      expect(res.status, id).toBe(404);
    }
  });
});

describe('operator-feedback-image', () => {
  test('運用者は画像をダウンロードとして受け取る（種類は meta.json の値）', async () => {
    const stored = await storeFeedback();
    const res = await post(app, operatorFeedbackImage, {
      token: await operator(),
      body: { id: feedbackImageRef(stored.feedbackId, stored.imageIds[0]!) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="feedback-${stored.imageIds[0]}.png"`);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toMatch(/^private/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(stored.imageBytes);
  });

  test('R2 のメタ情報の種類を信じず、meta.json の種類を返す', async () => {
    const stored = await storeFeedback();
    await env.ATTACHMENTS.put(`feedback/${stored.feedbackId}/${stored.imageIds[0]}`, stored.imageBytes, {
      httpMetadata: { contentType: 'text/html' },
    });
    const res = await post(app, operatorFeedbackImage, {
      token: await operator(),
      body: { id: feedbackImageRef(stored.feedbackId, stored.imageIds[0]!) },
    });
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  test('運用者でない人は 403', async () => {
    const stored = await storeFeedback();
    const res = await post(app, operatorFeedbackImage, {
      token: await ordinary(),
      body: { id: feedbackImageRef(stored.feedbackId, stored.imageIds[0]!) },
    });
    expect(res.status).toBe(403);
  });

  test('meta.json に無い画像、形の違う id、別の ID は 404', async () => {
    const stored = await storeFeedback();
    const stray = uuidv7();
    await env.ATTACHMENTS.put(`feedback/${stored.feedbackId}/${stray}`, stored.imageBytes);
    const ids = [
      feedbackImageRef(stored.feedbackId, stray),
      feedbackImageRef(stored.feedbackId, uuidv7()),
      feedbackImageRef(uuidv7(), stored.imageIds[0]!),
      stored.feedbackId,
      `${stored.feedbackId}.meta.json`,
    ];
    for (const id of ids) {
      const res = await post(app, operatorFeedbackImage, { token: await operator(), body: { id } });
      expect(res.status, id).toBe(404);
    }
  });

  test('組織の接頭辞の下のファイルは、どの id でも読めない', async () => {
    const stored = await storeFeedback();
    const organizationId = uuidv7();
    const orgFile = uuidv7();
    await env.ATTACHMENTS.put(`${organizationId}/${orgFile}`, stored.imageBytes);
    for (const id of [
      `${organizationId}.${orgFile}`,
      `${organizationId}/${orgFile}`,
      `${stored.feedbackId}.${organizationId}`,
    ]) {
      const res = await post(app, operatorFeedbackImage, { token: await operator(), body: { id } });
      expect([400, 404], id).toContain(res.status);
    }
  });

  test.each(['image/jpeg', 'image/webp'] as const)('meta.json の種類 %s をそのまま返す', async (contentType) => {
    const stored = await storeFeedback({ contentType });
    const ref = feedbackImageRef(stored.feedbackId, stored.imageIds[0]!);
    const res = await post(app, operatorFeedbackImage, { token: await operator(), body: { id: ref } });
    expect(res.headers.get('Content-Type')).toBe(contentType);
    expect(res.headers.get('Content-Length')).toBe(String(stored.imageBytes.byteLength));
    const listed = await post(app, operatorFeedback, { token: await operator(), body: { id: stored.feedbackId } });
    expect(((await listed.json()) as { images: { content_type: string }[] }).images[0]?.content_type).toBe(contentType);
  });

  test('実体が消えた画像の HEAD は 404', async () => {
    const stored = await storeFeedback();
    await env.ATTACHMENTS.delete(`feedback/${stored.feedbackId}/${stored.imageIds[0]}`);
    const res = await app.request(
      `/api/operator-feedback-image/${feedbackImageRef(stored.feedbackId, stored.imageIds[0]!)}`,
      { method: 'HEAD', headers: { Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${await operator()}` } },
      testEnv,
    );
    expect(res.status).toBe(404);
  });

  test('HEAD は本文なしで大きさだけを返す', async () => {
    const stored = await storeFeedback();
    const ref = feedbackImageRef(stored.feedbackId, stored.imageIds[0]!);
    const res = await app.request(
      `/api/operator-feedback-image/${ref}`,
      { method: 'HEAD', headers: { Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${await operator()}` } },
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(stored.imageBytes.byteLength));
    expect(await res.text()).toBe('');
  });

  test('長すぎる id は R2 を引く前に 400', async () => {
    const stored = await storeFeedback();
    const id = `${feedbackImageRef(stored.feedbackId, stored.imageIds[0]!)}/../x`;
    const res = await post(app, operatorFeedbackImage, { token: await operator(), body: { id } });
    expect(res.status).toBe(400);
  });

  test('画像の実体が消えていれば 404', async () => {
    const stored = await storeFeedback();
    await env.ATTACHMENTS.delete(`feedback/${stored.feedbackId}/${stored.imageIds[0]}`);
    const res = await post(app, operatorFeedbackImage, {
      token: await operator(),
      body: { id: feedbackImageRef(stored.feedbackId, stored.imageIds[0]!) },
    });
    expect(res.status).toBe(404);
  });
});
