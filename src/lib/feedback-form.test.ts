import { describe, expect, test } from 'vitest';
import type { ErrorBody } from '../shared/errors.ts';
import { feedbackSubmit } from '../shared/operations/feedback.ts';
import {
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_TEXT_MAX,
  admitFeedbackImages,
  clipboardImages,
  feedbackStallMs,
  sniffFeedbackImage,
  feedbackFailure,
  feedbackInput,
  feedbackTextLength,
  validateFeedback,
} from './feedback-form.ts';

const failed = (status: number, code: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: { code, message: 'x', ...(details === undefined ? {} : { details }) } as ErrorBody['error'],
});

describe('feedbackInput', () => {
  test('URL はクエリとフラグメントを除き、経路はそのまま送る', () => {
    // 画面は window.location をそのまま渡すので、href、search、hash も持つ形で確かめる
    const location = new URL('https://banmen.example.test/aoba/w/w1/board?task=t1&token=x#comments');
    const input = feedbackInput('見出しが読みにくい', '/[slug]/w/[id]/board', location);
    expect(input).toEqual({
      text: '見出しが読みにくい',
      route_id: '/[slug]/w/[id]/board',
      url: 'https://banmen.example.test/aoba/w/w1/board',
    });
    expect(feedbackSubmit.input.safeParse(input).success).toBe(true);
  });

  test('経路が無い画面は、操作の形に合う既知でない経路を送る（/ と取り違えない）', () => {
    const input = feedbackInput('a', null, { origin: 'http://localhost:5173', pathname: '/' });
    expect(input.route_id).not.toBe('/');
    expect(feedbackSubmit.input.safeParse(input).success).toBe(true);
  });
});

describe('validateFeedback', () => {
  test('空と空白だけは送らない', () => {
    expect(validateFeedback('')).toBe('feedbackEmpty');
    expect(validateFeedback(' \n\t')).toBe('feedbackEmpty');
  });

  test('上限ちょうどは通り、1字超えると止める。字はコードポイントで数える', () => {
    expect(validateFeedback('あ'.repeat(FEEDBACK_TEXT_MAX))).toBeNull();
    expect(validateFeedback('あ'.repeat(FEEDBACK_TEXT_MAX + 1))).toBe('feedbackTooLong');
    // サロゲートペアの絵文字も1字
    expect(validateFeedback('😀'.repeat(FEEDBACK_TEXT_MAX))).toBeNull();
  });

  test('CRLF と CR は1字に数える', () => {
    expect(feedbackTextLength('a\r\nb')).toBe(3);
    expect(feedbackTextLength('a\rb')).toBe(3);
  });

  test('画面に出ない文字は数えない（サーバーが除いてから数えるので、サーバーが受ける文を断らない）', () => {
    // 接合子でつないだ家族の絵文字は 7 コードポイントだが、サーバーは接合子を除いて 4 字に数える
    const family = '👨\u200d👩\u200d👧\u200d👦';
    expect(feedbackTextLength(family)).toBe(4);
    expect(validateFeedback(family.repeat(1250))).toBeNull();
    expect(validateFeedback(family.repeat(1251))).toBe('feedbackTooLong');
  });

  test('画面に出ない文字だけの文は空とみなす', () => {
    expect(validateFeedback('\u200b\u2060 \ufeff')).toBe('feedbackEmpty');
  });
});

describe('feedbackFailure', () => {
  test('秘密の検出は専用の文言、ほかの 400 は入力の誤り', () => {
    expect(
      feedbackFailure(failed(400, 'invalid_input', [{ path: 'text', code: 'custom', message: 'secret_detected' }])),
    ).toBe('feedbackSecret');
    expect(feedbackFailure(failed(400, 'invalid_input'))).toBe('feedbackInvalid');
  });

  test('回数の上限、受け付けていない、通信の失敗を分ける', () => {
    expect(feedbackFailure(failed(429, 'rate_limited'))).toBe('feedbackRateLimited');
    expect(feedbackFailure(failed(503, 'unavailable'))).toBe('feedbackUnavailable');
    expect(feedbackFailure({ ok: false, status: 0, error: null })).toBe('feedbackFailed');
    expect(feedbackFailure(failed(500, 'internal'))).toBe('feedbackFailed');
  });
});

describe('画像を付ける前の確かめ', () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const file = (bytes: number[], name: string, size = bytes.length) =>
    new File([new Uint8Array(Math.max(size, bytes.length)).map((_, i) => bytes[i] ?? 0)], name);

  test('形式は先頭のバイトで決め、名前と種類は見ない', () => {
    expect(sniffFeedbackImage(new Uint8Array(png))).toBe('image/png');
    expect(sniffFeedbackImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    const webp = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    expect(sniffFeedbackImage(new Uint8Array(webp))).toBe('image/webp');
    expect(sniffFeedbackImage(new TextEncoder().encode('<svg xmlns="x"/>'))).toBeNull();
  });

  test('形式の外、大きすぎる、枚数の外を、名前と理由つきで断る', async () => {
    const big = file(png, 'big.png', FEEDBACK_IMAGE_MAX_BYTES + 1);
    const svg = new File(['<svg/>'], 'a.png', { type: 'image/png' });
    const ok = (n: string) => file(png, n);
    const { accepted, rejected } = await admitFeedbackImages(
      [ok('a.png'), ok('b.png')],
      [big, svg, ok('c.png'), ok('d.png')],
    );
    expect(accepted.map((f) => f.name)).toEqual(['c.png']);
    expect(rejected).toEqual([
      { name: 'big.png', reason: 'feedbackImageTooLarge' },
      { name: 'a.png', reason: 'feedbackImageUnsupported' },
      { name: 'd.png', reason: 'feedbackImageTooMany' },
    ]);
  });

  test('4 MiB ちょうどは通る', async () => {
    const { accepted } = await admitFeedbackImages([], [file(png, 'x.png', FEEDBACK_IMAGE_MAX_BYTES)]);
    expect(accepted).toHaveLength(1);
  });

  test('サーバーが画像を断った理由を、画像の文言に写す', () => {
    const reason = (message: string) => feedbackFailure(failed(400, 'invalid_input', [{ message }]));
    expect(reason('too_many_images')).toBe('feedbackImageTooMany');
    expect(reason('image_too_large')).toBe('feedbackImageTooLarge');
    expect(reason('image_unsupported')).toBe('feedbackImageUnsupported');
  });

  test('読めないファイルは、そのファイルだけ断り、ほかは付ける', async () => {
    const unreadable = new File([new Uint8Array(png)], 'gone.png');
    Object.defineProperty(unreadable, 'slice', {
      value: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
    });
    const { accepted, rejected } = await admitFeedbackImages([], [unreadable, file(png, 'ok.png')]);
    expect(accepted.map((f) => f.name)).toEqual(['ok.png']);
    expect(rejected).toEqual([{ name: 'gone.png', reason: 'feedbackImageUnsupported' }]);
  });

  test('RIFF だけで WebP とみなさず、PNG の署名は8バイト全部を見る', () => {
    expect(sniffFeedbackImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(sniffFeedbackImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
  });

  test('詰まったとみなす時間は、付けた画像の大きさに応じて延びる', () => {
    expect(feedbackStallMs(0)).toBe(30_000);
    expect(feedbackStallMs(12 * 1024 * 1024)).toBe(30_000 + 120_000);
  });

  test('貼り付けは、文字が無いか、文字がファイルの名前だけのときだけ画像として付ける', () => {
    const image = new File([new Uint8Array(1)], 'shot.png', { type: 'image/png' });
    expect(clipboardImages([image], '')).toEqual([image]);
    expect(clipboardImages([image], 'shot.png')).toEqual([image]);
    expect(clipboardImages([image], '/Users/a/Desktop/shot.png\n')).toEqual([image]);
    // 文字が一緒（表計算のセル、文書の一部）、画像以外が混ざる、ファイルが無いときは、画像として付けない
    expect(clipboardImages([image], '売上\t120')).toEqual([]);
    expect(clipboardImages([image], '<TABLE>')).toEqual([]);
    expect(clipboardImages([image, new File(['a'], 'a.txt', { type: 'text/plain' })], '')).toEqual([]);
    expect(clipboardImages([], '')).toEqual([]);
  });
});
