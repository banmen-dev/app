// 中心座標を元画像の画素で持つ。拡大・移動しても枠が画像の外へ出ない。
export type Crop = { x: number; y: number; size: number };
export function cropSquare(width: number, height: number, zoom: number, x: number, y: number): Crop {
  const size = Math.min(width, height) / Math.max(1, Math.min(4, zoom));
  return {
    x: Math.max(0, Math.min(width - size, x - size / 2)),
    y: Math.max(0, Math.min(height - size, y - size / 2)),
    size,
  };
}
export const avatarImageTypes = ['image/png', 'image/jpeg', 'image/webp'];
export function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), type, 0.9),
  );
}
export async function encodeAvatar(canvas: HTMLCanvasElement): Promise<Blob> {
  const webp = await canvasBlob(canvas, 'image/webp');
  // Safari など WebP を書けないブラウザは PNG を返すので、明示的に JPEG にする。
  return webp.type === 'image/webp' ? webp : canvasBlob(canvas, 'image/jpeg');
}

// ファイル選択のMIMEだけではSVG/GIFなどの偽装を見分けられないため、先頭も照合する。
export async function isAvatarSource(file: File): Promise<boolean> {
  if (!avatarImageTypes.includes(file.type)) return false;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  if (file.type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    bytes.length === 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  );
}

export function drawCrop(context: CanvasRenderingContext2D, image: CanvasImageSource, crop: Crop): void {
  context.clearRect(0, 0, 256, 256);
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, 256, 256);
}
