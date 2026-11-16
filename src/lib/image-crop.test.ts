import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropSquare, encodeAvatar, isAvatarSource, drawCrop } from './image-crop.ts';

afterEach(() => vi.unstubAllGlobals());

describe('画像の切り抜き', () => {
  it('横長・縦長の写真を中央の正方形にし、拡大する', () => {
    expect(cropSquare(1200, 800, 1, 600, 400)).toEqual({ x: 200, y: 0, size: 800 });
    expect(cropSquare(800, 1200, 2, 400, 600)).toEqual({ x: 200, y: 400, size: 400 });
  });
  it('ドラッグ・矢印キーの移動や拡大で画像の外へ出ない', () => {
    for (const width of [1, 200, 1200])
      for (const height of [1, 400, 800]) {
        for (const zoom of [0, 1, 2, 4, 10])
          for (const position of [-10000, 0, 500, 10000]) {
            const crop = cropSquare(width, height, zoom, position, position);
            expect(crop.x).toBeGreaterThanOrEqual(0);
            expect(crop.y).toBeGreaterThanOrEqual(0);
            expect(crop.x + crop.size).toBeLessThanOrEqual(width);
            expect(crop.y + crop.size).toBeLessThanOrEqual(height);
          }
      }
  });
  it('WebP非対応ならPNGを送らずJPEGにする', async () => {
    const sourceToBlob = vi.fn((callback: BlobCallback) => callback(new Blob(['original'], { type: 'image/png' })));
    const fallbackToBlob = vi.fn((callback: BlobCallback) => callback(new Blob(['flattened'], { type: 'image/jpeg' })));
    const calls: string[] = [];
    const context = {
      fillStyle: '',
      fillRect: vi.fn(() => calls.push('white')),
      drawImage: vi.fn(() => calls.push('image')),
    };
    const fallback = { width: 0, height: 0, getContext: () => context, toBlob: fallbackToBlob };
    vi.stubGlobal('document', { createElement: () => fallback });
    const source = { width: 256, height: 256, toBlob: sourceToBlob } as unknown as HTMLCanvasElement;
    const result = await encodeAvatar(source);
    expect(context.fillStyle).toBe('#ffffff');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 256, 256);
    expect(calls).toEqual(['white', 'image']);
    expect(result.type).toBe('image/jpeg');
    expect(sourceToBlob).toHaveBeenCalledTimes(1);
    expect(sourceToBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.9);
    expect(fallbackToBlob).toHaveBeenCalledTimes(1);
    expect(fallbackToBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.9);
    expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(await result.text()).toBe('flattened');
  });
  it('再エンコードに失敗したら送信せず拒否する', async () => {
    await expect(
      encodeAvatar({ toBlob: (callback: BlobCallback) => callback(null) } as HTMLCanvasElement),
    ).rejects.toThrow('encode');
  });
});

it('MIMEと署名の両方を確かめ、SVG・GIF・切れたファイルを拒む', async () => {
  expect(
    await isAvatarSource(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'a.png', { type: 'image/png' })),
  ).toBe(true);
  expect(await isAvatarSource(new File([new Uint8Array([255, 216, 255])], 'a.jpg', { type: 'image/jpeg' }))).toBe(true);
  expect(await isAvatarSource(new File(['RIFF0000WEBP'], 'a.webp', { type: 'image/webp' }))).toBe(true);
  for (const data of ['GIF89a', '<svg></svg>', '', 'text']) {
    expect(await isAvatarSource(new File([data], 'fake.png', { type: 'image/png' }))).toBe(false);
  }
  expect(await isAvatarSource(new File(['GIF89a'], 'a.gif', { type: 'image/gif' }))).toBe(false);
});

it('透過画像を動かす前に前の画素を消し、枠の外の残像を上げない', () => {
  const calls: string[] = [];
  const clearRect = vi.fn(() => calls.push('clear'));
  const drawImage = vi.fn(() => calls.push('draw'));
  const context = { clearRect, drawImage, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' };
  drawCrop(context as unknown as CanvasRenderingContext2D, {} as ImageBitmap, {
    x: 100,
    y: 50,
    size: 200,
  });
  expect(context.imageSmoothingEnabled).toBe(true);
  expect(context.imageSmoothingQuality).toBe('high');
  expect(clearRect).toHaveBeenCalledWith(0, 0, 256, 256);
  expect(calls).toEqual(['clear', 'draw']);
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 50, 200, 200, 0, 0, 256, 256);
});

it('MIMEが空でもPNG・JPEG・WebPの署名が合えば受け付ける', async () => {
  for (const bytes of [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    new Uint8Array([255, 216, 255]),
    new TextEncoder().encode('RIFF0000WEBP'),
  ]) {
    expect(await isAvatarSource(new File([bytes], 'image'))).toBe(true);
  }
  expect(await isAvatarSource(new File(['<svg/>'], 'image'))).toBe(false);
});
