// プロフィール画像のヘッダーを読む（Issue #1265）。PNG、JPEG、WebP の種類、縦横、動く画像かを返し、
// ほかの種類とヘッダーを読めないバイトは null。画素は復号しない（ヘッダーだけを読む）。
// 種類は先頭のバイトで決め（src/server/attachments/sniff.ts と同じ）、縦横は種類ごとのヘッダーから読む。
// 動く画像は、PNG は IDAT より前の acTL（仕様では IDAT の後の acTL は静止画として表示される）、WebP は VP8X のアニメーションの印で見る。
// 縦横の上限で断るのは操作の側で、ここは宣言された値をそのまま返す
import { sniffContentType } from '../attachments/sniff.ts';

export type AvatarImage = {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  animated: boolean;
};

export function readAvatarImage(bytes: Uint8Array): AvatarImage | null {
  switch (sniffContentType(bytes.subarray(0, 64))) {
    case 'image/png':
      return readPng(bytes);
    case 'image/jpeg':
      return readJpeg(bytes);
    case 'image/webp':
      return readWebp(bytes);
    default:
      return null;
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i]!);
  return text;
}

// ---- PNG ----

const PNG_SIGNATURE_LENGTH = 8;

// 署名の後に、IHDR（長さ 13）が最初のチャンクとして続く。チャンクは 長さ(4) 種類(4) データ CRC(4)。
// IDAT まで読み進め、その前に acTL があれば動く PNG。IDAT に届かなければ（画像のデータが無いので）null
function readPng(bytes: Uint8Array): AvatarImage | null {
  const data = view(bytes);
  let offset = PNG_SIGNATURE_LENGTH;
  let width = 0;
  let height = 0;
  let animated = false;
  let first = true;
  while (offset + 8 <= bytes.length) {
    const length = data.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 8 + length + 4;
    if (first) {
      if (type !== 'IHDR' || length !== 13 || end > bytes.length) return null;
      width = data.getUint32(offset + 8);
      height = data.getUint32(offset + 12);
      first = false;
    } else if (type === 'IDAT') {
      if (width === 0 || height === 0) return null;
      return { contentType: 'image/png', width, height, animated };
    } else {
      if (end > bytes.length) return null;
      if (type === 'acTL') animated = true;
    }
    offset = end;
  }
  return null;
}

// ---- JPEG ----

// SOF0（ベースライン）、SOF1（拡張）、SOF2（プログレッシブ）。ほかの SOF（可逆、算術符号化など）は断る
function isSupportedSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xc2;
}

// SOI の後のマーカーを順に読み、SOF が来たら縦横を読む。SOF より前に SOS か EOI が来たら null。
// 縦横は SOF の 精度(1) 高さ(2) 幅(2)。高さ 0 は DNL で後から決める形なので null
function readJpeg(bytes: Uint8Array): AvatarImage | null {
  const data = view(bytes);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // マーカーの前の詰め物の 0xFF を飛ばす
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset]!;
    offset++;
    // 長さを持たないマーカー（TEM、RST0〜7、SOI）。0x00 は詰め物の印でマーカーではない
    if (marker === 0x00) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // 画像のデータの始まりと終わりまでに SOF が無い
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = data.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (!isSupportedSof(marker) || length < 8) return null;
      const height = data.getUint16(offset + 3);
      const width = data.getUint16(offset + 5);
      if (width === 0 || height === 0) return null;
      return { contentType: 'image/jpeg', width, height, animated: false };
    }
    offset += length;
  }
  return null;
}

// ---- WebP ----

// RIFF(4) 長さ(4) WEBP(4) の後、最初のチャンクが VP8、VP8L、VP8X のどれか。チャンクは FourCC(4) 長さ(4、リトルエンディアン) データ
function readWebp(bytes: Uint8Array): AvatarImage | null {
  const data = view(bytes);
  if (bytes.length < 20) return null;
  const type = ascii(bytes, 12, 4);
  const length = data.getUint32(16, true);
  const start = 20;
  if (start + length > bytes.length) return null;
  if (type === 'VP8 ') {
    // フレームの印（3 バイト。最下位ビットが 0 ならキーフレーム）、開始の印 9D 01 2A、幅と高さ（14 ビット + 拡大の指定 2 ビット）
    if (length < 10 || (bytes[start]! & 1) !== 0) return null;
    if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) return null;
    const width = data.getUint16(start + 6, true) & 0x3fff;
    const height = data.getUint16(start + 8, true) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { contentType: 'image/webp', width, height, animated: false };
  }
  if (type === 'VP8L') {
    // 印 0x2F の後に、幅-1（14 ビット）、高さ-1（14 ビット）、透明の有無（1 ビット）、版（3 ビット。0 だけ）
    if (length < 5 || bytes[start] !== 0x2f) return null;
    const bits = data.getUint32(start + 1, true);
    if (bits >>> 29 !== 0) return null;
    return {
      contentType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      animated: false,
    };
  }
  if (type === 'VP8X') {
    // フラグ(1)、予約(3)、キャンバスの幅-1(3) と高さ-1(3)（24 ビット、リトルエンディアン）。フラグの 0x02 がアニメーションの印
    if (length < 10) return null;
    const animated = (bytes[start]! & 0x02) !== 0;
    const width = 1 + (bytes[start + 4]! | (bytes[start + 5]! << 8) | (bytes[start + 6]! << 16));
    const height = 1 + (bytes[start + 7]! | (bytes[start + 8]! << 8) | (bytes[start + 9]! << 16));
    return { contentType: 'image/webp', width, height, animated };
  }
  return null;
}
