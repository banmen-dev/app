import { describe, expect, it, vi } from 'vitest';
import { uploadAvatar } from './avatar-upload.ts';

describe('プロフィール画像を上げる', () => {
  it('組織のバイナリ操作へ再エンコードした画像だけを送る', async () => {
    const blob = new Blob(['image'], { type: 'image/webp' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ avatar_url: '/api/aoba/user-avatar/new' }));
    expect(await uploadAvatar(blob, 'aoba', fetcher)).toEqual({
      ok: true,
      data: { avatar_url: '/api/aoba/user-avatar/new' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/aoba/me-avatar-upload',
      expect.objectContaining({
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Operation-Input': '%7B%7D' },
      }),
    );
  });
  it('400の理由と通信失敗、不正な成功応答を区別する', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: { code: 'invalid_input', message: 'invalid' } }, { status: 400 }));
    expect(await uploadAvatar(new Blob(), 'aoba', fetcher)).toMatchObject({ ok: false, status: 400 });
    fetcher.mockRejectedValueOnce(new Error('offline'));
    expect(await uploadAvatar(new Blob(), 'aoba', fetcher)).toEqual({ ok: false, status: 0, error: null });
    fetcher.mockResolvedValueOnce(Response.json({ unexpected: true }));
    expect(await uploadAvatar(new Blob(), 'aoba', fetcher)).toMatchObject({ ok: false });
  });
});
