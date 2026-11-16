// プロフィール画像のヘッダーを読む readAvatarImage（src/server/avatars/image.ts。Issue #1265）。
// PNG は IHDR、JPEG は SOF0〜SOF2（APP1 の Exif などの後ろにあってもよい）、WebP は VP8 / VP8L / VP8X から縦横を読む。
// 動く画像は、PNG は IDAT より前の acTL、WebP は VP8X のアニメーションの印で見る（人が決めたこと: 動く PNG と WebP はサーバーで断る）。
// PNG・JPEG・WebP でないバイトと、読めないヘッダーは null。画像のバイトは test/avatar-images.ts で仕様のとおりに組む
import { describe, expect, test } from 'vitest';
import { readAvatarImage } from '../src/server/avatars/image.ts';
import {
  JPEG_EOI,
  JPEG_SOI,
  PNG_SIGNATURE,
  VP8X_ALPHA,
  VP8X_ANIMATION,
  VP8X_EXIF,
  VP8X_ICC,
  VP8X_XMP,
  actl,
  apngImage,
  app0Jfif,
  app1Exif,
  ascii,
  concatBytes,
  dht,
  dqt,
  fctl,
  fdat,
  gifImage,
  idat,
  iend,
  ihdr,
  jpegImage,
  jpegSegment,
  pngChunk,
  pngImage,
  riffChunk,
  sof,
  svgImage,
  textChunk,
  vp8Frame,
  vp8lFrame,
  webpAnimated,
  webpExtended,
  webpFile,
  webpLossless,
  webpLossy,
} from './avatar-images.ts';

const still = (contentType: string, width: number, height: number) => ({ contentType, width, height, animated: false });

describe('PNG', () => {
  test.each([
    [1, 1],
    [64, 48],
    [512, 512],
    [513, 512],
    [512, 513],
    [4096, 3],
  ])('IHDR の %i×%i を返す', (width, height) => {
    expect(readAvatarImage(pngImage(width, height))).toEqual(still('image/png', width, height));
  });

  test('縦横は 32 ビットの大きな値もそのまま返す（上限で断るのは操作）', () => {
    expect(readAvatarImage(pngImage(100_000, 70_000))).toEqual(still('image/png', 100_000, 70_000));
  });

  test('IDAT より前に acTL があれば動く PNG（APNG）', () => {
    expect(readAvatarImage(apngImage(64, 48))).toEqual({
      contentType: 'image/png',
      width: 64,
      height: 48,
      animated: true,
    });
  });

  test('acTL が IHDR の直後でなく、ほかのチャンクの後ろにあっても IDAT より前なら動く PNG', () => {
    const bytes = pngImage(32, 32, { beforeIdat: [textChunk(5000), pngChunk('gAMA', new Uint8Array(4)), actl(3)] });
    expect(readAvatarImage(bytes)?.animated).toBe(true);
  });

  test('フレームが1つの acTL でも、IDAT より前なら動く PNG として扱う', () => {
    const bytes = pngImage(32, 32, { beforeIdat: [actl(1, 0), fctl(0, 32, 32)] });
    expect(readAvatarImage(bytes)?.animated).toBe(true);
  });

  test('IDAT の後の acTL は動く PNG にしない（仕様では静止画として表示される）', () => {
    const bytes = pngImage(32, 32, { afterIdat: [actl(2), fctl(1, 32, 32), fdat(2)] });
    expect(readAvatarImage(bytes)).toEqual(still('image/png', 32, 32));
  });

  test('IDAT が複数あっても静止画として読む', () => {
    const bytes = concatBytes(PNG_SIGNATURE, ihdr(16, 16), idat(), idat(), iend());
    expect(readAvatarImage(bytes)).toEqual(still('image/png', 16, 16));
  });

  test('IHDR の前と IDAT の前のほかのチャンクは飛ばす（IHDR の後の tEXt、pHYs）', () => {
    const bytes = pngImage(200, 100, {
      beforeIdat: [textChunk(100), pngChunk('pHYs', new Uint8Array(9))],
    });
    expect(readAvatarImage(bytes)).toEqual(still('image/png', 200, 100));
  });

  test.each([
    ['署名だけ', PNG_SIGNATURE],
    ['IHDR が途中で切れる', concatBytes(PNG_SIGNATURE, ihdr(10, 10).subarray(0, 15))],
    ['IHDR の後で IDAT に届かずに終わる', concatBytes(PNG_SIGNATURE, ihdr(10, 10))],
    [
      'IDAT より前のチャンクの長さがファイルの終わりを越える',
      concatBytes(PNG_SIGNATURE, ihdr(10, 10), textChunk(100).subarray(0, 50)),
    ],
    ['最初のチャンクが IHDR でない', concatBytes(PNG_SIGNATURE, textChunk(20), ihdr(10, 10), idat(), iend())],
    ['IHDR の長さが 13 でない', concatBytes(PNG_SIGNATURE, pngChunk('IHDR', new Uint8Array(12)), idat(), iend())],
    ['幅が 0', pngImage(0, 10)],
    ['高さが 0', pngImage(10, 0)],
    [
      '署名の1バイトが違う',
      concatBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]), pngImage(10, 10).subarray(8)),
    ],
  ])('%s は null', (_label, bytes) => {
    expect(readAvatarImage(bytes)).toBeNull();
  });
});

describe('JPEG', () => {
  test.each([
    ['ベースライン（SOF0）', 0xc0],
    ['拡張（SOF1）', 0xc1],
    ['プログレッシブ（SOF2）', 0xc2],
  ])('%s の縦横を返す', (_label, marker) => {
    expect(readAvatarImage(jpegImage(320, 240, { sofMarker: marker }))).toEqual(still('image/jpeg', 320, 240));
  });

  test.each([
    [1, 1],
    [512, 512],
    [513, 100],
    [100, 513],
    [65_535, 2],
  ])('%i×%i を返す（SOF は高さ、幅の順）', (width, height) => {
    expect(readAvatarImage(jpegImage(width, height))).toEqual(still('image/jpeg', width, height));
  });

  test('APP1（Exif）が数十 KB あっても、その後ろの SOF0 を読む', () => {
    const bytes = jpegImage(300, 200, { beforeSof: [app1Exif(40_000), dqt()] });
    expect(readAvatarImage(bytes)).toEqual(still('image/jpeg', 300, 200));
  });

  test('APP0、APP1、APP2、COM、DQT、DHT が SOF2 の前に並んでも読む', () => {
    const bytes = jpegImage(640, 480, {
      sofMarker: 0xc2,
      beforeSof: [
        app0Jfif(),
        app1Exif(1000),
        jpegSegment(0xe2, ascii('ICC_PROFILE\0')),
        jpegSegment(0xfe, ascii('架空のコメント')),
        dqt(),
        dht(),
      ],
    });
    expect(readAvatarImage(bytes)).toEqual(still('image/jpeg', 640, 480));
  });

  test('SOF の並びの番号でも SOF でない DHT（0xC4）を SOF と読まない', () => {
    // DHT の中身の先頭は、SOF と読むと高さ 1、幅 1281 の形になる
    const bytes = jpegImage(400, 300, { beforeSof: [dht(), dqt()] });
    expect(readAvatarImage(bytes)).toEqual(still('image/jpeg', 400, 300));
  });

  test('マーカーの前の詰め物の 0xFF を飛ばす', () => {
    const bytes = concatBytes(JPEG_SOI, app0Jfif(), new Uint8Array([0xff, 0xff]), sof(0xc0, 50, 40), dht(), JPEG_EOI);
    expect(readAvatarImage(bytes)).toEqual(still('image/jpeg', 50, 40));
  });

  test.each([
    ['SOI と EOI だけ', concatBytes(JPEG_SOI, JPEG_EOI)],
    ['SOI の後に SOF が無く終わる', concatBytes(JPEG_SOI, app0Jfif(), dqt())],
    ['SOF が途中で切れる', concatBytes(JPEG_SOI, app0Jfif(), sof(0xc0, 50, 40).subarray(0, 6))],
    ['APP1 の長さがファイルの終わりを越える', concatBytes(JPEG_SOI, app1Exif(1000).subarray(0, 200))],
    [
      'SOF より前に SOS が来る',
      concatBytes(JPEG_SOI, app0Jfif(), jpegSegment(0xda, new Uint8Array(10)), sof(0xc0, 50, 40), JPEG_EOI),
    ],
    ['幅が 0', jpegImage(0, 10)],
    ['高さが 0（DNL で後から決める形）', jpegImage(10, 0)],
    ['SOI の後がマーカーでない', concatBytes(JPEG_SOI, new Uint8Array([0x00, 0x11, 0x22, 0x33]))],
  ])('%s は null', (_label, bytes) => {
    expect(readAvatarImage(bytes)).toBeNull();
  });
});

describe('WebP', () => {
  test.each([
    [1, 1],
    [400, 300],
    [512, 512],
    [513, 512],
    [16_383, 2],
  ])('非可逆（VP8）の %i×%i を返す', (width, height) => {
    expect(readAvatarImage(webpLossy(width, height))).toEqual(still('image/webp', width, height));
  });

  test('VP8 の幅と高さの上位 2 ビット（拡大の指定）は縦横に含めない', () => {
    const bytes = webpFile(riffChunk('VP8 ', vp8Frame(300, 200, 3)));
    expect(readAvatarImage(bytes)).toEqual(still('image/webp', 300, 200));
  });

  test.each([
    [1, 1],
    [401, 299],
    [512, 512],
    [512, 513],
    [16_384, 16_384],
  ])('可逆（VP8L）の %i×%i を返す（幅-1、高さ-1 の 14 ビット）', (width, height) => {
    expect(readAvatarImage(webpLossless(width, height))).toEqual(still('image/webp', width, height));
  });

  test.each([
    [1, 1],
    [512, 256],
    [513, 513],
    [20_000, 10],
  ])('拡張（VP8X）の静止画はキャンバスの %i×%i を返す（24 ビット、幅-1 と高さ-1）', (width, height) => {
    expect(readAvatarImage(webpExtended(width, height))).toEqual(still('image/webp', width, height));
  });

  test.each([
    ['透明', VP8X_ALPHA],
    ['ICC', VP8X_ICC],
    ['EXIF', VP8X_EXIF],
    ['XMP', VP8X_XMP],
    ['透明、ICC、EXIF、XMP のすべて', VP8X_ALPHA | VP8X_ICC | VP8X_EXIF | VP8X_XMP],
  ])('VP8X の %s の印だけなら静止画', (_label, flags) => {
    expect(readAvatarImage(webpExtended(128, 64, flags))).toEqual(still('image/webp', 128, 64));
  });

  test('VP8X のアニメーションの印が立っていれば動く WebP', () => {
    expect(readAvatarImage(webpAnimated(64, 64))).toEqual({
      contentType: 'image/webp',
      width: 64,
      height: 64,
      animated: true,
    });
  });

  test('アニメーションの印はほかの印と一緒でも動く WebP', () => {
    expect(readAvatarImage(webpAnimated(64, 32, VP8X_ANIMATION | VP8X_ALPHA | VP8X_ICC))?.animated).toBe(true);
  });

  test('アニメーションの印だけを立てた静止画の形でも、印で動く WebP と見る', () => {
    expect(readAvatarImage(webpExtended(64, 64, VP8X_ANIMATION))?.animated).toBe(true);
  });

  test.each([
    ['RIFF と WEBP だけ', webpFile()],
    [
      'VP8 の開始の印が違う',
      webpFile(
        riffChunk(
          'VP8 ',
          (() => {
            const frame = vp8Frame(10, 10);
            frame[3] = 0x00;
            return frame;
          })(),
        ),
      ),
    ],
    ['VP8 が縦横の前で切れる', webpFile(riffChunk('VP8 ', vp8Frame(10, 10).subarray(0, 7)))],
    ['VP8 の幅が 0', webpLossy(0, 10)],
    [
      'VP8L の印が 0x2F でない',
      webpFile(
        riffChunk(
          'VP8L',
          (() => {
            const frame = vp8lFrame(10, 10);
            frame[0] = 0x2e;
            return frame;
          })(),
        ),
      ),
    ],
    ['VP8L が縦横の前で切れる', webpFile(riffChunk('VP8L', vp8lFrame(10, 10).subarray(0, 3)))],
    ['VP8X が 10 バイトに足りない', webpFile(riffChunk('VP8X', new Uint8Array(6)))],
    [
      '最初のチャンクが VP8、VP8L、VP8X でない',
      webpFile(riffChunk('ICCP', new Uint8Array(8)), riffChunk('VP8 ', vp8Frame(10, 10))),
    ],
    [
      'RIFF の後が WEBP でない（WAVE）',
      concatBytes(ascii('RIFF'), new Uint8Array([20, 0, 0, 0]), ascii('WAVE'), new Uint8Array(12)),
    ],
    ['チャンクの長さがファイルの終わりを越える', webpFile(riffChunk('VP8 ', vp8Frame(10, 10))).subarray(0, 24)],
  ])('%s は null', (_label, bytes) => {
    expect(readAvatarImage(bytes)).toBeNull();
  });
});

describe('PNG、JPEG、WebP でないものは null', () => {
  test.each([
    ['空', new Uint8Array(0)],
    ['1 バイト', new Uint8Array([0x89])],
    ['GIF89a', gifImage(10, 20)],
    ['GIF87a', concatBytes(ascii('GIF87a'), gifImage(10, 20).subarray(6))],
    ['SVG', svgImage()],
    ['XML 宣言の付いた SVG', concatBytes(ascii('<?xml version="1.0"?>'), svgImage())],
    ['HTML', ascii('<!DOCTYPE html><html><body>架空のページ</body></html>')],
    ['文章', ascii('ただの文章です')],
    ['BMP', concatBytes(ascii('BM'), new Uint8Array(60))],
    ['AVIF（ftyp avif）', concatBytes(new Uint8Array([0, 0, 0, 0x1c]), ascii('ftypavif'), new Uint8Array(16))],
    ['HEIC（ftyp heic）', concatBytes(new Uint8Array([0, 0, 0, 0x1c]), ascii('ftypheic'), new Uint8Array(16))],
    ['PDF', ascii('%PDF-1.7\n架空の文書')],
    ['0 で埋めたバイト', new Uint8Array(1024)],
  ])('%s', (_label, bytes) => {
    expect(readAvatarImage(bytes)).toBeNull();
  });

  test('PNG の署名の後ろが PNG のチャンクでない（SVG を続けた）なら null', () => {
    const bytes = concatBytes(PNG_SIGNATURE, svgImage());
    expect(readAvatarImage(bytes)).toBeNull();
  });
});

describe('入力', () => {
  test('大きな配列の一部（subarray）を渡しても、その範囲だけを読む', () => {
    const image = pngImage(40, 30);
    const buffer = concatBytes(new Uint8Array(17).fill(0xaa), image, new Uint8Array(9).fill(0xbb));
    expect(readAvatarImage(buffer.subarray(17, 17 + image.byteLength))).toEqual(still('image/png', 40, 30));
  });

  test('渡したバイトを書き換えない', () => {
    const bytes = apngImage(20, 20);
    const copy = bytes.slice();
    readAvatarImage(bytes);
    expect(bytes).toEqual(copy);
  });
});
