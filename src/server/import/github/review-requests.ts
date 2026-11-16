// レビュー依頼を履歴の最後まで読んでから返す。1呼び出し1要求で、同期の上限を越えて読み続けない。
// DB には書かない。保存と同期への組み込みは #1314 が受け持つ。
import type { FetchPageResult, ImportItem, ReviewRequestPageInput } from '../source.ts';
import { FULL_NAME_PATTERN, PAGE_SIZE, fail, getJson, idOf, isRecord } from './client.ts';

const ID = /^[1-9][0-9]{0,15}$/;
const MAX_PAGE = 100_000;
type Pull = { id: string; number: string; updatedAt: string };
type Position = {
  version: 1;
  scope: string;
  target: string | null;
  user: string;
  page: number;
  phase: 'list' | 'pull' | 'timeline' | 'finish';
  pull: Pull | null;
  historyPage: number;
  cycle: string | null;
  reviewed: boolean;
};

function invalid(): never {
  throw new TypeError('レビュー依頼の取得の入力が不正');
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('unavailable');
  return new Date(value).toISOString();
}
function numeric(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value) && Number.isSafeInteger(Number(value));
}
function pageNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PAGE;
}
function parse(input: ReviewRequestPageInput): Position | null {
  if (!numeric(input.scope.id) || !FULL_NAME_PATTERN.test(input.scope.name)) invalid();
  if (
    input.target &&
    (!numeric(input.target.sourceId) ||
      !numeric(input.target.key.split('#')[1]) ||
      input.target.key.split('#').length !== 2 ||
      !FULL_NAME_PATTERN.test(input.target.key.split('#')[0]!))
  )
    invalid();
  if (input.cursor === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    invalid();
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.scope !== input.scope.id ||
    value.target !== (input.target?.sourceId ?? null) ||
    !numeric(value.user) ||
    !pageNumber(value.page) ||
    !pageNumber(value.historyPage) ||
    !['list', 'pull', 'timeline', 'finish'].includes(String(value.phase)) ||
    !(value.cycle === null || numeric(value.cycle)) ||
    typeof value.reviewed !== 'boolean'
  )
    invalid();
  const pull = value.pull;
  if (
    pull !== null &&
    (!isRecord(pull) ||
      !numeric(pull.id) ||
      !numeric(pull.number) ||
      typeof pull.updatedAt !== 'string' ||
      (pull.updatedAt !== '' && !Number.isFinite(Date.parse(pull.updatedAt))))
  )
    invalid();
  if (value.phase !== 'list' && pull === null) invalid();
  if (
    input.target &&
    isRecord(pull) &&
    (pull.id !== input.target.sourceId || pull.number !== input.target.key.split('#')[1])
  )
    invalid();
  return value as unknown as Position;
}
function next(position: Position): FetchPageResult {
  if (!pageNumber(position.page) || !pageNumber(position.historyPage)) throw fail('unavailable');
  const cursor = JSON.stringify(position);
  if (cursor.length > 2000) throw fail('unavailable');
  return { items: [], next: cursor };
}
function pullOf(raw: unknown, expected?: Pull): Pull {
  if (!isRecord(raw)) throw fail('unavailable');
  const pull = { id: idOf(raw.id), number: idOf(raw.number), updatedAt: instant(raw.updated_at) };
  if (expected && (pull.id !== expected.id || pull.number !== expected.number)) throw fail('unavailable');
  return pull;
}

// target は保存済みの不変 ID と表示キー。番号だけで同一項目と判断せず、応答の ID を照合する。
// target なしでは closed も含め作成順に走査する（未完了一覧から消えたことを完了とみなさない）。
export async function fetchReviewRequestsPage(input: ReviewRequestPageInput): Promise<FetchPageResult> {
  const parsed = parse(input);
  const get = (path: string) => getJson(`https://api.github.com${path}`, input.credential, input.fetcher);
  const base = `/repositories/${input.scope.id}`;
  if (parsed === null) {
    const user = await get('/user');
    if (!isRecord(user) || user.type !== 'User') throw fail('unavailable');
    return next({
      version: 1,
      scope: input.scope.id,
      target: input.target?.sourceId ?? null,
      user: idOf(user.id),
      page: 1,
      phase: input.target ? 'pull' : 'list',
      pull: input.target ? { id: input.target.sourceId, number: input.target.key.split('#')[1]!, updatedAt: '' } : null,
      historyPage: 1,
      cycle: null,
      reviewed: false,
    });
  }
  const position = parsed;
  if (position.phase === 'list') {
    // 1件ずつ読むことで、履歴を読む間の一覧全体をカーソルに保存しない。
    const raw = await get(`${base}/pulls?state=all&sort=created&direction=asc&per_page=1&page=${position.page}`);
    if (!Array.isArray(raw) || raw.length > 1) throw fail('unavailable');
    if (raw.length === 0) return { items: [], next: null };
    return next({ ...position, pull: pullOf(raw[0]), phase: 'timeline' });
  }
  const pull = position.pull!;
  if (position.phase === 'pull') {
    const raw = await get(`${base}/pulls/${pull.number}`);
    return next({ ...position, pull: pullOf(raw, pull), phase: 'timeline' });
  }
  if (position.phase === 'timeline') {
    const raw = await get(`${base}/issues/${pull.number}/timeline?per_page=${PAGE_SIZE}&page=${position.historyPage}`);
    if (!Array.isArray(raw) || raw.length > PAGE_SIZE) throw fail('unavailable');
    let { cycle, reviewed } = position;
    for (const event of raw) {
      if (!isRecord(event) || typeof event.event !== 'string') throw fail('unavailable');
      if (event.event === 'review_requested' || event.event === 'review_request_removed') {
        // チーム宛ては展開しない。
        if (event.requested_reviewer === undefined || event.requested_reviewer === null) continue;
        if (!isRecord(event.requested_reviewer)) throw fail('unavailable');
        if (idOf(event.requested_reviewer.id) === position.user) {
          if (event.event === 'review_requested') {
            cycle = idOf(event.id);
            reviewed = false;
          } else if (!reviewed) {
            // 未提出の依頼解除は、後の PR 終了をレビュー完了にしない。
            // 提出後に依頼が外れた場合は、実際の提出の証拠を残す。
            cycle = null;
          }
        }
      } else if (event.event === 'reviewed') {
        if (!isRecord(event.user)) throw fail('unavailable');
        if (idOf(event.user.id) === position.user && cycle !== null) {
          if (!['approved', 'changes_requested', 'commented', 'dismissed'].includes(String(event.state))) {
            throw fail('unavailable');
          }
          instant(event.submitted_at);
          reviewed = true;
        }
      }
    }
    return next({
      ...position,
      cycle,
      reviewed,
      phase: raw.length === PAGE_SIZE ? 'timeline' : 'finish',
      historyPage: raw.length === PAGE_SIZE ? position.historyPage + 1 : position.historyPage,
    });
  }
  const raw = await get(`${base}/pulls/${pull.number}`);
  const current = pullOf(raw, pull);
  // 履歴取得中に PR が変わったら古い回で完了判定せず、上限を守りながら読み直す。
  if (current.updatedAt !== pull.updatedAt) {
    return next({ ...position, phase: 'pull', historyPage: 1, cycle: null, reviewed: false });
  }
  if (
    !isRecord(raw) ||
    (raw.state !== 'open' && raw.state !== 'closed') ||
    typeof raw.title !== 'string' ||
    !raw.title ||
    [...raw.title].length > 256 ||
    !Array.isArray(raw.requested_reviewers)
  )
    throw fail('unavailable');
  let requested = false;
  for (const user of raw.requested_reviewers) {
    if (!isRecord(user)) throw fail('unavailable');
    if (idOf(user.id) === position.user) requested = true;
  }
  // 一覧/履歴が食い違う場合も、推測で「完了」「新しい回」を作らない。
  if (requested && position.cycle === null) throw fail('unavailable');
  const items: ImportItem[] = [];
  if (position.cycle !== null && (requested || position.reviewed || raw.state === 'closed')) {
    // 範囲の名前は保存後に古くなりうる。現在の表示名は検証済みの応答から取る。
    const parts =
      typeof raw.html_url === 'string'
        ? /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/([1-9][0-9]*)$/.exec(raw.html_url)
        : null;
    if (!parts || !FULL_NAME_PATTERN.test(parts[1]!) || parts[2] !== pull.number) throw fail('unavailable');
    const name = parts[1]!;
    const url = `https://github.com/${name}/pull/${pull.number}`;
    items.push({
      kind: 'review_request',
      sourceId: pull.id,
      reviewerSourceId: position.user,
      reviewCycle: position.cycle,
      key: `${name}#${pull.number}`,
      url,
      title: raw.title,
      containerId: input.scope.id,
      containerName: name,
      status: raw.state,
      dueOn: null,
      updatedAt: current.updatedAt,
      isDone: position.reviewed || raw.state === 'closed',
    });
  }
  if (input.target) return { items, next: null };
  return {
    ...next({
      ...position,
      page: position.page + 1,
      phase: 'list',
      pull: null,
      historyPage: 1,
      cycle: null,
      reviewed: false,
    }),
    items,
  };
}
