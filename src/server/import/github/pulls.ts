// 更新日時の新しい順に、closed も含めて走査する。終了や更新で項目が動くと、新しい更新は先頭へ動き、
// 後ろの項目は頁を下へずれるだけなので、読み終えた頁より後ろの項目を取りこぼさない（重なりは sourceId で除く）。
// GitHub の pulls 一覧に since は無いので、差分の起点（input.since）より古い項目に達したら頁を打ち切る。
// 起点が無い（初めての同期）ときは最後の頁まで読む。更新日時による Issue の頁送りは流用しない。
import type { FetchPageInput, FetchPageResult, ImportItem } from '../source.ts';
import { PAGE_SIZE, fail, getJson, idOf, isRecord } from './client.ts';

const MAX_PAGE = 1_000_000;
const PULL_PATH = /^\/[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,15}$/;

export type GithubOwner = { id: string; login: string };

// login は改名・再取得できる。本人の判定には不変 ID だけを使う。
function isOwner(value: unknown, owner: GithubOwner): boolean {
  if (value === null || value === undefined) return false;
  if (!isRecord(value)) throw fail('unavailable');
  return idOf(value.id) === owner.id;
}

function isoOf(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw fail('unavailable');
  return new Date(value).toISOString();
}

function convert(raw: unknown, input: FetchPageInput, owner: GithubOwner): ImportItem | null {
  if (!isRecord(raw) || (raw.state !== 'open' && raw.state !== 'closed')) throw fail('unavailable');
  if (raw.state !== 'open') return null;
  const authored = isOwner(raw.user, owner);
  const assigned =
    isOwner(raw.assignee, owner) || (Array.isArray(raw.assignees) && raw.assignees.some((a) => isOwner(a, owner)));
  if (!authored && !assigned) return null;

  // 一覧の範囲を応答の base.repo でも確かめる。フォーク元（head.repo）とは比べない。
  if (!isRecord(raw.base) || !isRecord(raw.base.repo) || idOf(raw.base.repo.id) !== input.scope.id) {
    throw fail('unavailable');
  }
  const sourceId = idOf(raw.id);
  const number = idOf(raw.number);
  if (typeof raw.title !== 'string' || raw.title === '' || [...raw.title].length > 256) throw fail('unavailable');
  if (typeof raw.html_url !== 'string' || raw.html_url.length > 300) throw fail('unavailable');
  let url: URL;
  try {
    url = new URL(raw.html_url);
  } catch {
    throw fail('unavailable');
  }
  if (
    url.protocol !== 'https:' ||
    url.host !== 'github.com' ||
    url.search ||
    url.hash ||
    !PULL_PATH.test(url.pathname)
  ) {
    throw fail('unavailable');
  }
  const [, repositoryOwner, repo, , urlNumber] = url.pathname.split('/');
  if (urlNumber !== number) throw fail('unavailable');
  let dueOn: string | null = null;
  if (isRecord(raw.milestone) && raw.milestone.due_on != null) dueOn = isoOf(raw.milestone.due_on).slice(0, 10);
  return {
    kind: 'pull_request',
    sourceId,
    reviewerSourceId: '',
    key: `${repositoryOwner}/${repo}#${number}`,
    url: `https://github.com/${repositoryOwner}/${repo}/pull/${number}`,
    title: raw.title,
    containerId: input.scope.id,
    containerName: input.scope.name,
    status: 'open',
    dueOn,
    updatedAt: isoOf(raw.updated_at),
    isDone: false,
  };
}

export async function fetchOwnPullsPage(
  input: FetchPageInput,
  owner: GithubOwner,
  page: number,
): Promise<FetchPageResult> {
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new TypeError('PR の続きの位置が不正');
  const query = new URLSearchParams({
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: String(PAGE_SIZE),
    page: String(page),
  });
  const body = await getJson(
    `https://api.github.com/repositories/${input.scope.id}/pulls?${query}`,
    input.credential,
    input.fetcher,
  );
  if (!Array.isArray(body) || body.length > PAGE_SIZE) throw fail('unavailable');
  const found = new Map<string, ImportItem>();
  const since = input.since === undefined || input.since === null ? null : Date.parse(input.since);
  let reachedOlder = false;
  for (const raw of body as unknown[]) {
    // 更新日時の降順なので、起点より古い項目に達したら、それより後ろは読まない。起点ちょうどの項目は読む
    if (since !== null && isRecord(raw) && Date.parse(isoOf(raw.updated_at)) < since) {
      reachedOlder = true;
      break;
    }
    const item = convert(raw, input, owner);
    if (item !== null) found.set(item.sourceId, item);
  }
  const last = !reachedOlder && body.length === PAGE_SIZE;
  if (last && page === MAX_PAGE) throw fail('unavailable');
  return {
    items: [...found.values()],
    next: last ? `v3:pulls:${owner.id}:${owner.login}:${page + 1}` : null,
  };
}
