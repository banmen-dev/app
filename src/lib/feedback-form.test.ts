import { describe, expect, test } from 'vitest';
import type { ErrorBody } from '../shared/errors.ts';
import { feedbackSubmit } from '../shared/operations/feedback.ts';
import {
  FEEDBACK_TEXT_MAX,
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
