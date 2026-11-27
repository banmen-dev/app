// 右下のフィードバックのダイアログ（FeedbackLauncher.svelte）の、送る値の組み立て、入力の確かめ、失敗の振り分け。
// 画面の状態を持たない関数だけを置く（$app を読まないので、node で試せる）
import type { ApiResult } from './api.ts';
import { FEEDBACK_TEXT_MAX } from '../shared/operations/feedback.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

export { FEEDBACK_TEXT_MAX };

// 画面の経路が無いとき（どの route にも合わない画面）に送る値。操作の入力の形には合うが既知の経路の一覧に無いので、
// サーバーが null に置き換え、公開の Issue には経路が載らない。/ を送ると、組織の選択の画面から送ったように見えるため
const UNKNOWN_ROUTE_ID = '/[unknown]';

type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;

// 送る値。URL はクエリとフラグメントを除く（プライバシーポリシーの「預かるもの」。招待のトークンなどを送らない）
export function feedbackInput(
  text: string,
  routeId: string | null,
  location: { origin: string; pathname: string },
): { text: string; route_id: string; url: string } {
  return { text, route_id: routeId ?? UNKNOWN_ROUTE_ID, url: `${location.origin}${location.pathname}` };
}

// 画面に出ない文字（Default_Ignorable と、タブと改行の外の制御文字）。サーバー（normalizeFeedbackText）は
// これらを除いてから数える。ここではそれより多めに除き、サーバーが受ける文を画面が断らない側に寄せる
// （サーバーは絵文字の直後の U+FE0F を1つ残すので、ここで通ってもまれに 400 になる。そのときは feedbackFailure が受け持つ）
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|(?![\t\n])\p{Cc}/gu;

// 字は Unicode のコードポイントで数え、改行の CRLF と CR は1字にする
export function feedbackTextLength(text: string): number {
  return [...text.replace(/\r\n?/g, '\n').replace(INVISIBLE, '')].length;
}

// 送る前の確かめ。空（空白と画面に出ない文字だけを含む）と、上限を超えた文は送らない
export function validateFeedback(text: string): DictionaryKey | null {
  if (text.replace(INVISIBLE, '').trim() === '') return 'feedbackEmpty';
  if (feedbackTextLength(text) > FEEDBACK_TEXT_MAX) return 'feedbackTooLong';
  return null;
}

function hasSecretProblem(result: FailedResult): boolean {
  const details = result.error?.details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (item: unknown) =>
      typeof item === 'object' && item !== null && 'message' in item && item.message === 'secret_detected',
  );
}

// 失敗を、欄の下に出す文言に写す。どの失敗でも入力は残す。
// ログインが切れた（401）と、規約に同意していない（403 の terms_required）は、呼び出し側が画面ごと移すので、ここへ渡さない
export function feedbackFailure(result: FailedResult): DictionaryKey {
  if (result.status === 400) return hasSecretProblem(result) ? 'feedbackSecret' : 'feedbackInvalid';
  if (result.status === 429) return 'feedbackRateLimited';
  if (result.status === 503) return 'feedbackUnavailable';
  return 'feedbackFailed';
}
