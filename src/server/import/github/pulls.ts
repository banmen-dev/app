// 作成順で closed も含めて走査する。終了や更新で既読の PR が一覧から抜けると、頁番号だけでは未読を取りこぼすため。
// GitHub の pulls 一覧に since は無いので、更新日時による Issue の頁送りを流用しない。
import type { FetchPageInput, FetchPageResult, ImportItem } from '../source.ts';
import { PAGE_SIZE, fail, getJson, idOf, isRecord } from './client.ts';

const MAX_PAGE = 1_000_000;
const PULL_PATH = /^\/[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,15}$/;

function sameLogin(value: unknown, login: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === login.toLowerCase();
}

function isoOf(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw fail('unavailable');
  return new Date(value).toISOString();
}

function convert(raw: unknown, input: FetchPageInput, login: string): ImportItem | null {
  if (!isRecord(raw) || (raw.state !== 'open' && raw.state !== 'closed')) throw fail('unavailable');
  if (raw.state !== 'open') return null;
  const authored = isRecord(raw.user) && sameLogin(raw.user.login, login);
  const assigned =
    (isRecord(raw.assignee) && sameLogin(raw.assignee.login, login)) ||
    (Array.isArray(raw.assignees) && raw.assignees.some((a) => isRecord(a) && sameLogin(a.login, login)));
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
  const [, owner, repo, , urlNumber] = url.pathname.split('/');
  if (urlNumber !== number) throw fail('unavailable');
  let dueOn: string | null = null;
  if (isRecord(raw.milestone) && raw.milestone.due_on != null) dueOn = isoOf(raw.milestone.due_on).slice(0, 10);
  return {
    kind: 'pull_request',
    sourceId,
    reviewerSourceId: '',
    key: `${owner}/${repo}#${number}`,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: raw.title,
    containerId: input.scope.id,
    containerName: input.scope.name,
    status: 'open',
    dueOn,
    updatedAt: isoOf(raw.updated_at),
    isDone: false,
  };
}

export async function fetchOwnPullsPage(input: FetchPageInput, login: string, page: number): Promise<FetchPageResult> {
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new TypeError('PR の続きの位置が不正');
  const query = new URLSearchParams({
    state: 'all',
    sort: 'created',
    direction: 'asc',
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
  for (const raw of body as unknown[]) {
    const item = convert(raw, input, login);
    if (item !== null) found.set(item.sourceId, item);
  }
  if (body.length === PAGE_SIZE && page === MAX_PAGE) throw fail('unavailable');
  return { items: [...found.values()], next: body.length < PAGE_SIZE ? null : `v1:pulls:${login}:${page + 1}` };
}
