// Issue と PR の取得段階を続き位置に含める。各呼び出しは一覧1頁までで、同期の予算を跨いでも再開できる。
import type { FetchPageInput, FetchPageResult } from '../source.ts';
import { FULL_NAME_PATTERN, LOGIN_PATTERN } from './client.ts';
import { fetchAssignedIssuesPage, loginOf, parseIssueCursor } from './issues.ts';
import { fetchOwnPullsPage } from './pulls.ts';

export async function fetchOwnItemsPage(input: FetchPageInput): Promise<FetchPageResult> {
  if (!/^[1-9][0-9]{0,15}$/.test(input.scope.id) || !FULL_NAME_PATTERN.test(input.scope.name)) {
    throw new TypeError('担当の項目の取得の入力が不正');
  }
  if (input.cursor?.startsWith('v1:pulls:')) {
    const match = /^v1:pulls:([^:]+):([1-9][0-9]{0,6})$/.exec(input.cursor);
    if (match === null || !LOGIN_PATTERN.test(match[1]!)) throw new TypeError('PR の続きの位置が不正');
    return fetchOwnPullsPage(input, match[1]!, Number(match[2]));
  }
  // 旧版の login:page:anchor は Issue 段階として引き継ぐ。不正な値は通信前に断る。
  const cursor = input.cursor?.startsWith('v1:issues:') ? input.cursor.slice('v1:issues:'.length) : input.cursor;
  const position = parseIssueCursor(cursor);
  const login = position.login ?? (await loginOf(input));
  const result = await fetchAssignedIssuesPage({ ...input, cursor, settings: { ...input.settings, login } });
  return {
    items: result.items,
    next: result.next === null ? `v1:pulls:${login}:1` : `v1:issues:${result.next}`,
  };
}
