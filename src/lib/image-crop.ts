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
export const AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const avatarImageTypes = ['image/png', 'image/jpeg', 'image/webp'];
export function avatarSourceError(file: Pick<File, 'type' | 'size'>): 'type' | 'size' | null {
  if (file.type !== '' && !avatarImageTypes.includes(file.type)) return 'type';
  return file.size > AVATAR_SOURCE_MAX_BYTES ? 'size' : null;
}
export function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), type, 0.9),
  );
}
export async function encodeAvatar(canvas: HTMLCanvasElement): Promise<Blob> {
  const webp = await canvasBlob(canvas, 'image/webp');
  // Safari など WebP を書けないブラウザは PNG を返すので、明示的に JPEG にする。
  if (webp.type === 'image/webp') return webp;
  // JPEGに透過は無いため、ブラウザ任せの黒ではなく白地へ合成する。
  const fallback = document.createElement('canvas');
  fallback.width = canvas.width;
  fallback.height = canvas.height;
  const context = fallback.getContext('2d');
  if (!context) throw new Error('encode');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, fallback.width, fallback.height);
  context.drawImage(canvas, 0, 0);
  return canvasBlob(fallback, 'image/jpeg');
}

// ファイル選択のMIMEだけではSVG/GIFなどの偽装を見分けられないため、先頭も照合する。
export async function isAvatarSource(file: File): Promise<boolean> {
  if (file.type !== '' && !avatarImageTypes.includes(file.type)) return false;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.length === 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  return (
    (file.type === '' && (png || jpeg || webp)) ||
    (file.type === 'image/png' && png) ||
    (file.type === 'image/jpeg' && jpeg) ||
    (file.type === 'image/webp' && webp)
  );
}

export function drawCrop(context: CanvasRenderingContext2D, image: CanvasImageSource, crop: Crop): void {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, 256, 256);
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, 256, 256);
}
