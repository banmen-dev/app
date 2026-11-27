// 右下のフィードバックのダイアログ（FeedbackLauncher.svelte）の、送る値の組み立て、入力の確かめ、失敗の振り分け。
// 画面の状態を持たない関数だけを置く（$app を読まないので、node で試せる）
import type { ApiResult } from './api.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

// 本文の上限（字）。サーバーの feedback-submit も同じ数で確かめる（src/server/operations/feedback.ts）
export const FEEDBACK_TEXT_MAX = 5000;

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

// 字数はサーバーと同じく Unicode のコードポイントで数え、改行の CRLF は1字にする。
// サーバーは見えない文字を除いてから数えるので、ここで通っても 400 になることがある（そのときは feedbackFailure が受け持つ）
export function feedbackTextLength(text: string): number {
  return [...text.replace(/\r\n/g, '\n')].length;
}

// 送る前の確かめ。空（空白だけを含む）と、上限を超えた文は送らない
export function validateFeedback(text: string): DictionaryKey | null {
  if (text.trim() === '') return 'feedbackEmpty';
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
