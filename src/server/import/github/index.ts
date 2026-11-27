// GitHub の取り込み元（fine-grained PAT）。通信先は固定の URL で、設定から読まない。
// GitHub に固有の値と処理は、このディレクトリの外に出さない。
// 通信の作法はログインの auth/github.ts と同じ（固定の URL、redirect: 'manual'、時間切れ、固定の文のエラー）
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import {
  type CredentialOwner,
  type FetchPageInput,
  type FetchPageResult,
  type ImportSource,
  type ScopeCandidate,
} from '../source.ts';
import { FULL_NAME_PATTERN, LOGIN_PATTERN, PAGE_SIZE, fail, getJson, idOf, isRecord } from './client.ts';
import { fetchOwnItemsPage } from './items.ts';
import { fetchKnownItem } from './known-item.ts';
import { fetchReviewRequestsPage } from './review-requests.ts';

const USER_URL = 'https://api.github.com/user';
const REPOS_URL = 'https://api.github.com/user/repos';

// 頁送りの上限。超える（100頁目まで満杯で続く）ときは、止まらずに回り続けないよう断る
const MAX_PAGES = 100;
// 候補の一覧の期限。各頁を始める前に判定するので、最悪は、これに1回分の時間切れ（10秒）を足した時間になる
const LIST_DEADLINE_MS = 60_000;

// fine-grained PAT: `github_pat_` + 英数字とアンダースコア。全体で255文字まで
const PAT_PATTERN = /^github_pat_[A-Za-z0-9_]{22,244}$/;

function isShape(credential: unknown): credential is string {
  return typeof credential === 'string' && PAT_PATTERN.test(credential);
}

function requireShape(credential: unknown): string {
  if (!isShape(credential)) throw fail('invalid_format');
  return credential;
}

async function verifyCredential(credential: string, fetcher: typeof fetch): Promise<CredentialOwner> {
  const pat = requireShape(credential);
  const body = await getJson(USER_URL, pat, fetcher);
  if (!isRecord(body)) throw fail('unavailable');
  const id = idOf(body.id);
  const name = body.login;
  if (typeof name !== 'string' || !LOGIN_PATTERN.test(name)) throw fail('unavailable');
  if (body.type !== 'User' && body.type !== 'Organization') throw fail('unavailable');
  return { kind: body.type === 'User' ? 'user' : 'organization', id, name };
}

async function listScopeCandidates(credential: string, fetcher: typeof fetch): Promise<ScopeCandidate[]> {
  const pat = requireShape(credential);
  const found = new Map<string, ScopeCandidate>();
  const deadline = Date.now() + LIST_DEADLINE_MS;
  // 101頁目は、100頁目まで満杯だったときに続きが無いことを確かめるためだけに取る
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    if (Date.now() > deadline) throw fail('unavailable');
    const body = await getJson(`${REPOS_URL}?per_page=${PAGE_SIZE}&page=${page}`, pat, fetcher);
    if (!Array.isArray(body)) throw fail('unavailable');
    if (page > MAX_PAGES && body.length > 0) throw fail('unavailable');
    for (const item of body as unknown[]) {
      if (!isRecord(item)) throw fail('unavailable');
      const id = idOf(item.id);
      const name = item.full_name;
      if (typeof name !== 'string' || !FULL_NAME_PATTERN.test(name)) throw fail('unavailable');
      if (!found.has(id)) found.set(id, { id, name });
    }
    if (body.length < PAGE_SIZE) return [...found.values()];
  }
  throw fail('unavailable');
}

// 同期の候補列挙は1要求ずつ返し、10要求の予算をまたいでも先へ進める。
async function fetchScopeCandidatesPage(input: { credential: string; fetcher: typeof fetch; cursor: string | null }) {
  const page = input.cursor === null ? 1 : Number(input.cursor);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > MAX_PAGES + 1 ||
    (input.cursor !== null && String(page) !== input.cursor)
  )
    throw new TypeError('範囲候補の続きの位置が不正');
  const body = await getJson(
    `${REPOS_URL}?per_page=${PAGE_SIZE}&page=${page}`,
    requireShape(input.credential),
    input.fetcher,
  );
  if (!Array.isArray(body) || body.length > PAGE_SIZE || (page > MAX_PAGES && body.length > 0))
    throw fail('unavailable');
  const candidates: ScopeCandidate[] = body.map((item: unknown) => {
    if (!isRecord(item) || typeof item.full_name !== 'string' || !FULL_NAME_PATTERN.test(item.full_name))
      throw fail('unavailable');
    return { id: idOf(item.id), name: item.full_name };
  });
  return { candidates, next: body.length < PAGE_SIZE ? null : String(page + 1) };
}

// 範囲のリポジトリの、担当 Issue → 作者または担当 PR の順で1頁取る。
async function fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
  return fetchOwnItemsPage({ ...input, credential: requireShape(input.credential) });
}

export const githubImportSource: ImportSource = {
  kind: 'github',
  scopeKind: 'github_repo',
  parseSettings(settings) {
    if (settings === undefined) return {};
    if (isRecord(settings) && Object.keys(settings).length === 0) return {};
    return null;
  },
  isCredentialShape: isShape,
  credentialLast4(credential) {
    return requireShape(credential).slice(-4);
  },
  verifyCredential,
  listScopeCandidates,
  fetchPage,
  fetchScopeCandidatesPage,
  async fetchReviewRequestsPage(input) {
    return fetchReviewRequestsPage({ ...input, credential: requireShape(input.credential) });
  },
  async fetchKnownItem(input) {
    return fetchKnownItem({ ...input, credential: requireShape(input.credential) });
  },
};
