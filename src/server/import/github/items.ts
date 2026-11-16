// Issue と PR の取得段階を続き位置に含める。各呼び出しは一覧1頁までで、同期の予算を跨いでも再開できる。
import type { FetchPageInput, FetchPageResult } from '../source.ts';
import { FULL_NAME_PATTERN, LOGIN_PATTERN, fail, getJson, idOf, isRecord } from './client.ts';
import { fetchAssignedIssuesPage, parseIssueCursor } from './issues.ts';
import { fetchOwnPullsPage, type GithubOwner } from './pulls.ts';

type Position = { phase: 'issues' | 'pulls'; page: number; anchor: string | null; owner: GithubOwner | null };

function invalid(): never {
  throw new TypeError('担当の項目の続きの位置が不正');
}

function parsePosition(cursor: string | null): Position {
  if (cursor === null) return { phase: 'issues', page: 1, anchor: null, owner: null };
  // v2 は不変の本人 ID を持つ。文字列としても正規形に絞り、壊れた入力では問い合わせない。
  const modern = /^v2:(issues|pulls):([1-9][0-9]{0,15}):(.+)$/.exec(cursor);
  if (modern !== null) {
    const id = modern[2]!;
    if (!Number.isSafeInteger(Number(id)) || String(Number(id)) !== id) invalid();
    if (modern[1] === 'issues') {
      const position = parseIssueCursor(modern[3]!);
      return { ...position, phase: 'issues', owner: { id, login: position.login! } };
    }
    const match = /^([^:]+):([1-9][0-9]{0,6})$/.exec(modern[3]!);
    if (match === null || !LOGIN_PATTERN.test(match[1]!) || Number(match[2]) > 1_000_000) invalid();
    return { phase: 'pulls', page: Number(match[2]), anchor: null, owner: { id, login: match[1]! } };
  }
  if (cursor.startsWith('v1:pulls:')) {
    const match = /^v1:pulls:([^:]+):([1-9][0-9]{0,6})$/.exec(cursor);
    if (match === null || !LOGIN_PATTERN.test(match[1]!) || Number(match[2]) > 1_000_000) invalid();
    return { phase: 'pulls', page: Number(match[2]), anchor: null, owner: null };
  }
  const position = parseIssueCursor(cursor.startsWith('v1:issues:') ? cursor.slice('v1:issues:'.length) : cursor);
  return { ...position, phase: 'issues', owner: null };
}

async function readOwner(input: FetchPageInput): Promise<GithubOwner> {
  // settings.login だけでは本人 ID を確定できない。初回と旧カーソル移行では必ず PAT の持ち主を照会する。
  const body = await getJson('https://api.github.com/user', input.credential, input.fetcher);
  if (!isRecord(body) || typeof body.login !== 'string' || !LOGIN_PATTERN.test(body.login)) throw fail('unavailable');
  return { id: idOf(body.id), login: body.login };
}

function cursorOf(position: Position, owner: GithubOwner): string {
  return position.phase === 'pulls'
    ? `v2:pulls:${owner.id}:${owner.login}:${position.page}`
    : `v2:issues:${owner.id}:${owner.login}:${position.page}:${position.anchor ?? ''}`;
}

export async function fetchOwnItemsPage(input: FetchPageInput): Promise<FetchPageResult> {
  if (!/^[1-9][0-9]{0,15}$/.test(input.scope.id) || !FULL_NAME_PATTERN.test(input.scope.name)) {
    throw new TypeError('担当の項目の取得の入力が不正');
  }
  const position = parsePosition(input.cursor);
  const owner = position.owner ?? (await readOwner(input));
  // 旧位置には本人 ID が無い。本人確認だけの1要求で移行して、次の呼び出しで同じ段階・頁から取る。
  if (input.cursor !== null && position.owner === null) return { items: [], next: cursorOf(position, owner) };
  if (position.phase === 'pulls') return fetchOwnPullsPage(input, owner, position.page);
  const cursor = `${owner.login}:${position.page}:${position.anchor ?? ''}`;
  const result = await fetchAssignedIssuesPage({
    ...input,
    cursor,
    settings: { ...input.settings, login: owner.login },
  });
  return {
    items: result.items,
    next: result.next === null ? `v2:pulls:${owner.id}:${owner.login}:1` : `v2:issues:${owner.id}:${result.next}`,
  };
}
