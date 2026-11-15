// プロフィール画像のテスト（Issue #1265）が使う、画像のバイトの組み立て。PNG、JPEG、WebP のヘッダーを仕様のとおりに組み、
// 断る種類（GIF、SVG）も作る。画素は復号しないので、本体のデータ（PNG の IDAT、JPEG のスキャン、WebP のフレーム）は
// 宣言した縦横に合わない小さな値でよい（サーバーはヘッダーだけを読む）

const encoder = new TextEncoder();

export function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const u8 = (...values: number[]) => new Uint8Array(values);
const u16be = (value: number) => u8((value >>> 8) & 0xff, value & 0xff);
const u32be = (value: number) => u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const u16le = (value: number) => u8(value & 0xff, (value >>> 8) & 0xff);
const u24le = (value: number) => u8(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff);
const u32le = (value: number) => u8(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);

// 決まった値で埋めたバイト（長さを合わせる詰め物）
export function filler(length: number, value = 0x61): Uint8Array {
  return new Uint8Array(length).fill(value);
}

// ---- PNG ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const PNG_SIGNATURE = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

// 長さ、種類、データ、CRC（種類とデータに掛ける）
export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const typed = concatBytes(ascii(type), data);
  return concatBytes(u32be(data.byteLength), typed, u32be(crc32(typed)));
}

// 幅、高さ、ビット深度、色の種類（6 は RGBA）、圧縮、フィルター、インターレース
export function ihdr(width: number, height: number): Uint8Array {
  return pngChunk('IHDR', concatBytes(u32be(width), u32be(height), u8(8, 6, 0, 0, 0)));
}

// 1×1 の RGBA の1行（フィルター 0 と 4 バイト）を zlib で縮めたもの
const TINY_ZLIB = u8(0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01);

export const idat = (data: Uint8Array = TINY_ZLIB) => pngChunk('IDAT', data);
export const iend = () => pngChunk('IEND');
// APNG の動きの宣言（フレームの数、繰り返しの数）
export const actl = (frames = 2, plays = 0) => pngChunk('acTL', concatBytes(u32be(frames), u32be(plays)));
// APNG のフレームの宣言（番号、幅、高さ、位置、遅れ、処分と重ね方）
export function fctl(sequence: number, width: number, height: number): Uint8Array {
  return pngChunk(
    'fcTL',
    concatBytes(u32be(sequence), u32be(width), u32be(height), u32be(0), u32be(0), u16be(1), u16be(10), u8(0, 0)),
  );
}
export const fdat = (sequence: number) => pngChunk('fdAT', concatBytes(u32be(sequence), TINY_ZLIB));
export const textChunk = (length: number) =>
  pngChunk('tEXt', concatBytes(ascii('Comment\0'), filler(Math.max(0, length - 8))));

export type PngOptions = {
  // IHDR と IDAT の間のチャンク
  beforeIdat?: readonly Uint8Array[];
  // IDAT と IEND の間のチャンク
  afterIdat?: readonly Uint8Array[];
  // ファイル全体をこのバイト数にする（IEND の前に tEXt を足して合わせる）
  totalBytes?: number;
};

export function pngImage(width: number, height: number, options: PngOptions = {}): Uint8Array {
  const head = concatBytes(PNG_SIGNATURE, ihdr(width, height), ...(options.beforeIdat ?? []), idat());
  const tail = [...(options.afterIdat ?? [])];
  const base = concatBytes(head, ...tail, iend());
  if (options.totalBytes === undefined) return base;
  // tEXt は長さ・種類・CRC の 12 バイトと、キーワードの 8 バイトを持つ
  const dataLength = options.totalBytes - base.byteLength - 12;
  if (dataLength < 8) throw new Error(`${options.totalBytes} バイトには合わせられない`);
  const out = concatBytes(head, ...tail, textChunk(dataLength), iend());
  if (out.byteLength !== options.totalBytes) throw new Error('長さの合わせ方を誤った');
  return out;
}

// 動く PNG（APNG）。acTL と最初の fcTL は IDAT より前、2つ目のフレームは IDAT の後
export function apngImage(width: number, height: number): Uint8Array {
  return pngImage(width, height, {
    beforeIdat: [actl(2), fctl(0, width, height)],
    afterIdat: [fctl(1, width, height), fdat(2)],
  });
}

// ---- JPEG ----

export const JPEG_SOI = u8(0xff, 0xd8);
export const JPEG_EOI = u8(0xff, 0xd9);

// マーカーと、長さ（長さの 2 バイトを含む）とデータ
export function jpegSegment(marker: number, data: Uint8Array): Uint8Array {
  return concatBytes(u8(0xff, marker), u16be(data.byteLength + 2), data);
}

export const app0Jfif = () =>
  jpegSegment(0xe0, concatBytes(ascii('JFIF\0'), u8(0x01, 0x01, 0x00), u16be(1), u16be(1), u8(0, 0)));

// Exif（TIFF の頭と、詰め物）。携帯の写真は縮小の画像を入れるので、数十 KB になる
export const app1Exif = (padding = 0) =>
  jpegSegment(0xe1, concatBytes(ascii('Exif\0\0'), ascii('MM'), u8(0x00, 0x2a), u32be(8), filler(padding, 0x00)));

export const dqt = () => jpegSegment(0xdb, concatBytes(u8(0x00), filler(64, 0x01)));

// ハフマンの表（DHT、0xC4）。SOF の並びの番号だが SOF ではない。中身を SOF と読むと縦横を誤る
export const dht = () =>
  jpegSegment(
    0xc4,
    concatBytes(u8(0x00), u8(0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0), u8(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
  );

// フレームの頭。精度、高さ、幅、成分の数と成分ごとの指定（Y、Cb、Cr）
export function sof(marker: number, width: number, height: number): Uint8Array {
  return jpegSegment(
    marker,
    concatBytes(u8(8), u16be(height), u16be(width), u8(3, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01)),
  );
}

const sos = () => jpegSegment(0xda, u8(3, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00));

export type JpegOptions = {
  // SOF の番号（0xC0 はベースライン、0xC2 はプログレッシブ）
  sofMarker?: number;
  // SOI と SOF の間のセグメント（省略は APP0 の JFIF と DQT）
  beforeSof?: readonly Uint8Array[];
};

export function jpegImage(width: number, height: number, options: JpegOptions = {}): Uint8Array {
  return concatBytes(
    JPEG_SOI,
    ...(options.beforeSof ?? [app0Jfif(), dqt()]),
    sof(options.sofMarker ?? 0xc0, width, height),
    dht(),
    sos(),
    u8(0x12, 0x34, 0x56, 0x00, 0x78),
    JPEG_EOI,
  );
}

// ---- WebP ----

// FourCC、長さ（リトルエンディアン）、データ、奇数の長さなら詰め物の 1 バイト
export function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  return concatBytes(ascii(fourcc), u32le(data.byteLength), data, data.byteLength % 2 === 1 ? u8(0) : u8());
}

export function webpFile(...chunks: readonly Uint8Array[]): Uint8Array {
  const body = concatBytes(ascii('WEBP'), ...chunks);
  return concatBytes(ascii('RIFF'), u32le(body.byteLength), body);
}

// 非可逆（VP8）のキーフレーム。フレームの印（キーフレーム、表示する、最初の区画の長さ 16）、開始の印、
// 幅と高さ（下位 14 ビットが px、上位 2 ビットが拡大の指定）
export function vp8Frame(width: number, height: number, scale = 0): Uint8Array {
  const tag = (16 << 5) | (1 << 4);
  return concatBytes(
    u8(tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff),
    u8(0x9d, 0x01, 0x2a),
    u16le((width & 0x3fff) | (scale << 14)),
    u16le((height & 0x3fff) | (scale << 14)),
    filler(10, 0x00),
  );
}

// 可逆（VP8L）。印 0x2F と、幅-1（14 ビット）、高さ-1（14 ビット）、透明の有無（1 ビット）、版（3 ビット、0）
export function vp8lFrame(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14) | (1 << 28);
  return concatBytes(u8(0x2f), u32le(bits >>> 0), filler(6, 0x00));
}

export const VP8X_ICC = 0x20;
export const VP8X_ALPHA = 0x10;
export const VP8X_EXIF = 0x08;
export const VP8X_XMP = 0x04;
export const VP8X_ANIMATION = 0x02;

// 拡張の形の頭。フラグ、予約の 3 バイト、キャンバスの幅-1 と高さ-1（24 ビット）
export function vp8xChunk(flags: number, width: number, height: number): Uint8Array {
  return riffChunk('VP8X', concatBytes(u8(flags, 0, 0, 0), u24le(width - 1), u24le(height - 1)));
}

export const webpLossy = (width: number, height: number) => webpFile(riffChunk('VP8 ', vp8Frame(width, height)));
export const webpLossless = (width: number, height: number) => webpFile(riffChunk('VP8L', vp8lFrame(width, height)));

// 拡張の形の静止画（VP8X の後に VP8）
export function webpExtended(width: number, height: number, flags = 0): Uint8Array {
  return webpFile(vp8xChunk(flags, width, height), riffChunk('VP8 ', vp8Frame(width, height)));
}

// 動く WebP（VP8X のアニメーションの印、ANIM、ANMF が 2 つ）
export function webpAnimated(width: number, height: number, flags = VP8X_ANIMATION): Uint8Array {
  const frame = () =>
    riffChunk(
      'ANMF',
      concatBytes(
        u24le(0),
        u24le(0),
        u24le(width - 1),
        u24le(height - 1),
        u24le(100),
        u8(0),
        riffChunk('VP8 ', vp8Frame(width, height)),
      ),
    );
  return webpFile(
    vp8xChunk(flags, width, height),
    riffChunk('ANIM', concatBytes(u32le(0), u16le(0))),
    frame(),
    frame(),
  );
}

// ---- 断る種類 ----

// GIF89a、論理画面の幅と高さ、フラグ、背景、比率、画像の区切りと終わり
export function gifImage(width: number, height: number): Uint8Array {
  return concatBytes(
    ascii('GIF89a'),
    u16le(width),
    u16le(height),
    u8(0x00, 0x00, 0x00),
    u8(0x2c),
    filler(9, 0),
    u8(0x3b),
  );
}

export const svgImage = () =>
  ascii('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30"/></svg>');
