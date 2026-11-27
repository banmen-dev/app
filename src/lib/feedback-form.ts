// 右下のフィードバックのダイアログ（FeedbackLauncher.svelte）の、送る値の組み立て、入力の確かめ、失敗の振り分け。
// 画面の状態を持たない関数だけを置く（$app を読まないので、node で試せる）
import type { ApiResult } from './api.ts';
import {
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_IMAGE_MAX_SIDE,
  FEEDBACK_TEXT_MAX,
} from '../shared/operations/feedback.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

export { FEEDBACK_IMAGE_MAX_BYTES, FEEDBACK_IMAGE_MAX_COUNT, FEEDBACK_TEXT_MAX };

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
  // 対にならないサロゲートを先に除く（見えない文字を先に除くと、間に挟まれた上位と下位の片割れが対になって残る）
  if (text.replace(EMPTY_EXTRA, '').replace(INVISIBLE, '').trim() === '') return 'feedbackEmpty';
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
  if (result.status === 400) {
    if (hasSecretProblem(result)) return 'feedbackSecret';
    return imageProblemKey(result) ?? 'feedbackInvalid';
  }
  if (result.status === 429) return 'feedbackRateLimited';
  if (result.status === 503) return 'feedbackUnavailable';
  return 'feedbackFailed';
}

// サーバーが画像を断った理由（details の message）を、欄の下に出す文言に写す。画面の確かめを通っても、
// サーバーだけが見られる理由（動く画像、一辺の画素数の上限、申告と違う中身）で断られることがある
function imageProblemKey(result: FailedResult): DictionaryKey | null {
  const details = result.error?.details;
  if (!Array.isArray(details)) return null;
  for (const item of details as unknown[]) {
    if (typeof item !== 'object' || item === null || !('message' in item)) continue;
    if (item.message === 'too_many_images') return 'feedbackImageTooMany';
    if (item.message === 'image_too_large') return 'feedbackImageTooLarge';
    if (item.message === 'image_unsupported') return 'feedbackImageUnsupported';
  }
  return null;
}

// 文言の {count}、{size}、{max} に入れる値。画面とサーバーで同じ上限を使う
export const FEEDBACK_MESSAGE_PARAMS = {
  max: FEEDBACK_TEXT_MAX.toLocaleString('ja-JP'),
  count: String(FEEDBACK_IMAGE_MAX_COUNT),
  size: String(FEEDBACK_IMAGE_MAX_BYTES / 1024 / 1024),
  side: FEEDBACK_IMAGE_MAX_SIDE.toLocaleString('ja-JP'),
} as const;

// 書き込みを詰まったとみなすまでの時間（feedback-draft.svelte.ts の説明）
export const FEEDBACK_STALL_MS = 30_000;

// 送っている間を詰まったとみなすまでの時間。画像は大きいので、付けた分の大きさに応じて延ばす（遅い回線で、送れている最中に
// 詰まったと出して二重に送らせないため）。1 MiB あたり 10 秒を足す
export function feedbackStallMs(imageBytes: number): number {
  return FEEDBACK_STALL_MS + Math.ceil(imageBytes / (1024 * 1024)) * 10_000;
}

export type FeedbackImageType = 'image/png' | 'image/jpeg' | 'image/webp';

// 先頭のバイトで形式を決める（ファイルの種類と名前は申告なので使わない。サーバーも中身で決める）。
// 貼り付けた画像は種類が空のことがあるので、種類で決めない
export function sniffFeedbackImage(head: Uint8Array): FeedbackImageType | null {
  const at = (offset: number, bytes: readonly number[]) => bytes.every((byte, i) => head[offset + i] === byte);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

export type FeedbackImageRejection = {
  name: string;
  reason: 'feedbackImageTooLarge' | 'feedbackImageUnsupported' | 'feedbackImageTooMany';
};

// 付けようとしたファイルを、付けた分に足せるかを確かめる。足せないものは、名前と理由を返す（付けた分は変えない）。
// 枚数は、付けた分と合わせて上限まで先着順に足し、はみ出した分は枚数の理由で断る。
// 動く画像と画素数の上限はサーバーだけが読むので、ここでは見ず、送ったときの失敗で出す
export async function admitFeedbackImages(
  current: readonly File[],
  candidates: readonly File[],
): Promise<{ accepted: File[]; rejected: FeedbackImageRejection[] }> {
  const accepted: File[] = [];
  const rejected: FeedbackImageRejection[] = [];
  for (const file of candidates) {
    // 読めないファイル（選んだ後に消えた、フォルダーなど）は、形式の外として断る
    const kind = await file
      .slice(0, 16)
      .arrayBuffer()
      .then((head) => sniffFeedbackImage(new Uint8Array(head)))
      .catch(() => null);
    if (kind === null) {
      rejected.push({ name: file.name, reason: 'feedbackImageUnsupported' });
    } else if (file.size > FEEDBACK_IMAGE_MAX_BYTES) {
      rejected.push({ name: file.name, reason: 'feedbackImageTooLarge' });
    } else if (current.length + accepted.length >= FEEDBACK_IMAGE_MAX_COUNT) {
      rejected.push({ name: file.name, reason: 'feedbackImageTooMany' });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}
