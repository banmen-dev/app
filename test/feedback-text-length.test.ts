// 画面のフィードバックの字数（src/lib/feedback-form.ts の feedbackTextLength）が、サーバーが正規化した後の字数
// （src/server/feedback/github-app.ts の normalizeFeedbackText）より少なくならないことのテスト（Issue #1554）。
// 画面が少なく数えると、上限の近くの文を画面が通し、サーバーが 400 を返して「送れない文字」と食い違う理由を出すため。
// 見えない文字はソースに直に書かず、番号から作る
import { describe, expect, test } from 'vitest';
import { feedbackTextLength, validateFeedback } from '../src/lib/feedback-form.ts';
import { normalizeFeedbackText } from '../src/server/feedback/github-app.ts';
import { FEEDBACK_TEXT_MAX } from '../src/shared/operations/feedback.ts';

const c = (...codes: number[]) => String.fromCodePoint(...codes);
const serverLength = (text: string) => [...normalizeFeedbackText(text)].length;

const samples: Record<string, string> = {
  'CR LF': `a${c(0x0d, 0x0a)}b`,
  CR: `a${c(0x0d)}b`,
  NEL: `a${c(0x85)}b`,
  LS: `a${c(0x2028)}b`,
  PS: `a${c(0x2029)}b`,
  タブ: `a${c(0x09)}b`,
  '絵文字の直後の U+FE0F': `${c(0x263a, 0xfe0f)}`,
  '絵文字でない文字の後の U+FE0F': `a${c(0xfe0f)}`,
  接合子でつないだ絵文字: c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
  キーキャップ: c(0x31, 0xfe0f, 0x20e3),
  ゼロ幅の空白と結合子: `a${c(0x200b)}b${c(0x2060)}c${c(0xfeff)}`,
  双方向の制御: `${c(0x202e)}abc${c(0x202c)}`,
  タグの文字: `${c(0x1f3f4, 0xe0067, 0xe0062, 0xe007f)}`,
  漢字の異体字の指定: `${c(0x845b, 0xe0100)}`,
  注釈の文字: `${c(0xfff9)}a${c(0xfffa)}b${c(0xfffb)}`,
  対にならないサロゲート: `a${String.fromCharCode(0xd800)}b`,
  制御文字: `a${c(0x00)}b${c(0x1f)}c${c(0x7f)}d${c(0x9f)}`,
};

describe('画面の字数はサーバーの字数より少なくならない', () => {
  for (const [name, text] of Object.entries(samples)) {
    test(name, () => {
      expect(feedbackTextLength(text)).toBeGreaterThanOrEqual(serverLength(text));
    });
  }

  test('画面が通す上限ちょうどの文は、サーバーも上限の内に数える', () => {
    const heart = c(0x2764, 0xfe0f);
    const text = heart.repeat(FEEDBACK_TEXT_MAX / 2);
    expect(validateFeedback(text)).toBeNull();
    expect(serverLength(text)).toBeLessThanOrEqual(FEEDBACK_TEXT_MAX);
    expect(validateFeedback(text + 'a')).toBe('feedbackTooLong');
  });
});

describe('サーバーが空にする文は、画面も空とみなす', () => {
  const empties: Record<string, string> = {
    'U+FE0F だけ': c(0xfe0f),
    注釈の文字だけ: c(0xfff9, 0xfffa, 0xfffb),
    対にならないサロゲートだけ: String.fromCharCode(0xd800),
    画面に出ない文字と空白だけ: `${c(0x200b)} ${c(0x2060)}${c(0x09)}${c(0x85)}`,
  };
  for (const [name, text] of Object.entries(empties)) {
    test(name, () => {
      expect(normalizeFeedbackText(text).trim()).toBe('');
      expect(validateFeedback(text)).toBe('feedbackEmpty');
    });
  }

  test('対になったサロゲート（絵文字）は空にしない', () => {
    expect(validateFeedback(c(0x1f600))).toBeNull();
  });
});
