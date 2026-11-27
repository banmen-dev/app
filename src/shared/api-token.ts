// API トークン（docs/data-model.md の `api_tokens`）の形と上限。Authorization: Bearer に載せる
// 新しく発行するトークンの接頭辞
export const API_TOKEN_PREFIX = 'bnp_';
// 旧名（Scrum Guild）の接頭辞。API_TOKEN_LEGACY_LAST_DAY（UTC の日付）まで検証だけ受け付ける
export const API_TOKEN_LEGACY_PREFIX = 'sgp_';
export const API_TOKEN_LEGACY_LAST_DAY = '2027-03-27';

// 検証が通す形。新しい接頭辞と、最終日までの旧の接頭辞のどちらも、乱数は base64url の43文字
export const API_TOKEN_PATTERN = /^(?:bnp|sgp)_[A-Za-z0-9_-]{43}$/;

// 旧の接頭辞を受け付けるのは、now の UTC の日付が最終日以前のあいだ（最終日の終わりまで通し、翌日の 00:00 から断る）
export function isLegacyApiTokenAccepted(now: Date): boolean {
  // 数で比べる（文字列では西暦10000年以降の '+' が先に来て通ってしまう）。不正な Date は NaN で false
  return now.getTime() < Date.parse(API_TOKEN_LEGACY_LAST_DAY) + 24 * 60 * 60 * 1000;
}

// 発行から失効までの上限の日数。使っても延ばさない
export const API_TOKEN_MAX_LIFETIME_DAYS = 90;

// 1アカウントが持てる有効な（取り消していない、期限前の）トークンの数。超える発行は 409 の conflict（details.reason は API_TOKEN_LIMIT_REASON）
export const API_TOKEN_MAX_ACTIVE = 20;
export const API_TOKEN_LIMIT_REASON = 'limit';

// API トークンの発行は、ログイン（sessions.created_at）からこの分数以内のセッションに限る。ちょうどこの分数は通す
export const API_TOKEN_REAUTH_MINUTES = 10;

// read は mode が read の操作だけ、write は read と write の操作を呼べる
export type ApiTokenScope = 'read' | 'write';
