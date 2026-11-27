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

// 画面に出ない文字（U+FE0F を除く Default_Ignorable と、タブと改行の外の制御文字）。サーバー（normalizeFeedbackText）も
// これらを除いてから数える。U+FE0F はサーバーが絵文字の直後の1つを残すので、ここでは除かずに数える
// （サーバーが受ける文より多めに数えるのは、絵文字でない文字の後の U+FE0F、対にならないサロゲート、U+FFF9〜U+FFFB だけで、
// どれも画面が断る側に出る。字数では、画面が通してサーバーが 400 を返す向きは作らない）
const INVISIBLE = /(?!\ufe0f)\p{Default_Ignorable_Code_Point}|(?![\t\n])\p{Cc}/gu;
// サーバーが LF にそろえる改行（CR LF、CR、NEL、LS、PS）。NEL は制御文字なので、除く前に改行へ直す
const LINE_BREAK = /\r\n|[\r\u0085\u2028\u2029]/g;

// 字は Unicode のコードポイントで数え、改行はどの形も1字にする
export function feedbackTextLength(text: string): number {
  return [...text.replace(LINE_BREAK, '\n').replace(INVISIBLE, '')].length;
}

// 空の判定で、字数では数えるがサーバーが除く文字（U+FE0F、注釈の文字 U+FFF9〜U+FFFB、対にならないサロゲート）も除く。
// 除かないと、これらだけの文を画面が通し、サーバーが空として 400 を返して「送れない文字」と出る。
// u フラグの文字の集合は、対になったサロゲートを1つのコードポイントとして扱うので、対にならない片割れだけに当たる
const EMPTY_EXTRA = /[\ufe0f\ufff9-\ufffb\ud800-\udfff]/gu;

// 送る前の確かめ。空（空白と画面に出ない文字だけを含む）と、上限を超えた文は送らない
export function validateFeedback(text: string): DictionaryKey | null {
  if (text.replace(INVISIBLE, '').replace(EMPTY_EXTRA, '').trim() === '') return 'feedbackEmpty';
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
