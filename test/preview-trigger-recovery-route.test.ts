import { describe, expect, it, vi } from 'vitest';
import type { PreviewRecovery } from '../src/server/preview-trigger/queue.ts';
import { handlePreviewRecovery } from '../src/server/preview-trigger/recovery.ts';

const origin = 'https://preview-trigger.example.test';
const issue = '1379';
const path = `/operator/preview-queues/${issue}`;
const secret = 'preview-recovery-test-secret-not-a-real-key';
const attempt = { sha: '0123456789abcdef0123456789abcdef01234567', attemptedAt: 1_790_000_000_000 };
const buildId = '49b20bde-4cd5-4e31-b4fa-17b5bfbaf90f';
const reset = { ...attempt, resolution: 'not-started' } satisfies PreviewRecovery;
const attach = { ...attempt, resolution: 'attach', buildId } satisfies PreviewRecovery;

function request({
  route = path,
  method = 'GET',
  authorization = `Bearer ${secret}`,
  body,
}: {
  route?: string;
  method?: string;
  authorization?: string | null;
  body?: string | ReadableStream<Uint8Array>;
} = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (authorization !== null) headers.set('Authorization', authorization);
  return new Request(origin + route, { method, headers, body });
}

function queue(statusValue: typeof attempt | null = attempt) {
  const status = vi.fn<() => Promise<typeof attempt | null>>(async () => statusValue);
  const recover = vi.fn<(recovery: PreviewRecovery) => Promise<boolean>>(async () => true);
  const queueFor = vi.fn<(issue: string) => { status: typeof status; recover: typeof recover }>(() => ({
    status,
    recover,
  }));
  return { status, recover, queueFor };
}

describe('プレビューキューの運用者入口', () => {
  it.each([undefined, ''])('復旧用 Secret が未設定ならキューを見ず 503 を返す', async (configuredSecret) => {
    const { queueFor } = queue();

    const response = await handlePreviewRecovery(request(), configuredSecret, queueFor);

    expect(response.status).toBe(503);
    expect(queueFor).not.toHaveBeenCalled();
  });

  it.each([null, 'Bearer another-secret', `Basic ${secret}`, `Bearer ${secret}x`])(
    'Bearer 認証が一致しない場合はキューを見ず 401 を返す (%s)',
    async (authorization) => {
      const { queueFor } = queue();

      const response = await handlePreviewRecovery(
        request({ method: 'POST', authorization, body: JSON.stringify(reset) }),
        secret,
        queueFor,
      );

      expect(response.status).toBe(401);
      expect(queueFor).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/operator/preview-queues',
    '/operator/preview-queues/0',
    '/operator/preview-queues/01379',
    '/operator/preview-queues/-1379',
    '/operator/preview-queues/1379/another',
    '/github/webhook',
  ])('正の Issue 番号を持つ復旧パス以外ではキューを見ず 404 を返す (%s)', async (route) => {
    const { queueFor } = queue();

    expect((await handlePreviewRecovery(request({ route }), secret, queueFor)).status).toBe(404);
    expect(queueFor).not.toHaveBeenCalled();
  });

  it('GET と POST 以外のメソッドは 405 を返す', async () => {
    const { queueFor } = queue();

    expect((await handlePreviewRecovery(request({ method: 'DELETE' }), secret, queueFor)).status).toBe(405);
    expect(queueFor).not.toHaveBeenCalled();
  });

  it.each([attempt, null])('認証済みの GET は指定 Issue の起動状態だけを返す', async (statusValue) => {
    const { queueFor, status, recover } = queue(statusValue);

    const response = await handlePreviewRecovery(request(), secret, queueFor);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attempt: statusValue });
    expect(queueFor).toHaveBeenCalledExactlyOnceWith(issue);
    expect(status).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([reset, attach])('認証済みの POST は明示的な復旧操作を指定 Issue にだけ渡す', async (recovery) => {
    const { queueFor, status, recover } = queue();

    const response = await handlePreviewRecovery(
      request({ method: 'POST', body: JSON.stringify(recovery) }),
      secret,
      queueFor,
    );

    expect(response.status).toBe(204);
    expect(queueFor).toHaveBeenCalledExactlyOnceWith(issue);
    expect(recover).toHaveBeenCalledExactlyOnceWith(recovery);
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    ['不正な JSON', '{"sha":'],
    ['null', 'null'],
    ['配列', '[]'],
    ['SHA なし', JSON.stringify({ ...reset, sha: undefined })],
    ['大文字の SHA', JSON.stringify({ ...reset, sha: attempt.sha.toUpperCase() })],
    ['39 桁の SHA', JSON.stringify({ ...reset, sha: attempt.sha.slice(1) })],
    ['0 の時刻', JSON.stringify({ ...reset, attemptedAt: 0 })],
    ['小数の時刻', JSON.stringify({ ...reset, attemptedAt: attempt.attemptedAt + 0.5 })],
    ['文字列の時刻', JSON.stringify({ ...reset, attemptedAt: String(attempt.attemptedAt) })],
    ['方式なし', JSON.stringify(attempt)],
    ['未知の方式', JSON.stringify({ ...reset, resolution: 'retry' })],
    ['attach に UUID なし', JSON.stringify({ ...attach, buildId: undefined })],
    ['attach に不正 UUID', JSON.stringify({ ...attach, buildId: 'build-1' })],
    ['attach に大文字 UUID', JSON.stringify({ ...attach, buildId: buildId.toUpperCase() })],
  ])('%s の復旧入力ではキューを変更せず 400 を返す', async (_label, body) => {
    const { queueFor, recover } = queue();

    expect((await handlePreviewRecovery(request({ method: 'POST', body }), secret, queueFor)).status).toBe(400);
    expect(recover).not.toHaveBeenCalled();
  });

  it('Content-Length のない大きなボディも 413 を返す', async () => {
    const { queueFor, recover } = queue();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(' '.repeat(1024 * 1024 + 1)));
        controller.close();
      },
    });
    const incoming = request({ method: 'POST', body });
    expect(incoming.headers.has('Content-Length')).toBe(false);

    expect((await handlePreviewRecovery(incoming, secret, queueFor)).status).toBe(413);
    expect(recover).not.toHaveBeenCalled();
  });

  it('復旧対象が一致しないときは 409 を返す', async () => {
    const { queueFor, recover } = queue();
    recover.mockResolvedValue(false);

    const response = await handlePreviewRecovery(
      request({ method: 'POST', body: JSON.stringify(attach) }),
      secret,
      queueFor,
    );

    expect(response.status).toBe(409);
    expect(recover).toHaveBeenCalledExactlyOnceWith(attach);
  });

  it.each(['GET', 'POST'])('%s の内部障害は詳細を開示せず 503 を返す', async (method) => {
    const { queueFor, status, recover } = queue();
    const internalError = '内部ログ専用のテスト文字列';
    status.mockRejectedValue(new Error(internalError));
    recover.mockRejectedValue(new Error(internalError));

    const response = await handlePreviewRecovery(
      request({ method, body: method === 'POST' ? JSON.stringify(attach) : undefined }),
      secret,
      queueFor,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(internalError);
  });
});
