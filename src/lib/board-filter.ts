import type { SprintBoardColumn, SprintBoardTask } from '../shared/operations/sprint/index.ts';

// ボードの絞り込み（#1502）。読み込んだボードを画面で絞り、条件を URL の問い合わせに残す。
// q は題の部分一致（大文字と小文字、全角と半角を区別しない）。assignee、story、epic、category は選んだ値の並びで、
// 同じ条件の中はどれか1つに当たればよく（または）、条件どうしはすべてに当たる（かつ）。値の none は「無い」を選ぶ。
// URL は ?q=語&assignee=<ID>&assignee=none&story=<ID>… の形。前からある ?story=<ID> のリンク（通知など）もそのまま読める
export const BOARD_FILTER_NONE = 'none';
export const BOARD_FILTER_KEYS = ['assignee', 'story', 'epic', 'category'] as const;
export type BoardFilterKey = (typeof BOARD_FILTER_KEYS)[number];
export const BOARD_GROUPS = ['assignee', 'story', 'epic'] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];
export function boardGroupOf(value: string | null): BoardGroup | undefined {
  return BOARD_GROUPS.find((group) => group === value);
}

export type BoardFilter = { q: string; group?: BoardGroup } & Record<BoardFilterKey, readonly string[]>;
// 検索の語の上限（題の上限と同じ 200 字）。URL で長い値を渡されても、ここで切る
export const BOARD_QUERY_MAX_LENGTH = 200;
// 1つの条件で選べる値の上限。URL で多くの値を渡されても、ここで切る
const MAX_VALUES = 100;

// 検索の語の前後の空白を除き、上限の字数で切る。字数は題の上限と同じくコードポイントで数え、絵文字の途中で切らない
export function clampQuery(text: string): string {
  return [...text.trim()].slice(0, BOARD_QUERY_MAX_LENGTH).join('');
}

export const emptyBoardFilter: BoardFilter = { q: '', assignee: [], story: [], epic: [], category: [] };

export function boardFilterOf(params: Pick<URLSearchParams, 'get' | 'getAll'>): BoardFilter {
  const values = (key: BoardFilterKey): string[] =>
    [...new Set(params.getAll(key).filter((value) => value !== ''))].slice(0, MAX_VALUES);
  const group = boardGroupOf(params.get('group'));
  return {
    ...(group === undefined ? {} : { group }),
    q: clampQuery(params.get('q') ?? ''),
    assignee: values('assignee'),
    story: values('story'),
    epic: values('epic'),
    category: values('category'),
  };
}

// 絞り込みだけを書いた問い合わせ（先頭の ? を含まない）。絞っていなければ空
export function boardFilterQuery(filter: BoardFilter): string {
  const params = new URLSearchParams();
  if (filter.q !== '') params.set('q', filter.q);
  if (filter.group !== undefined) params.set('group', filter.group);
  for (const key of BOARD_FILTER_KEYS) for (const value of filter[key]) params.append(key, value);
  return params.toString();
}

// 今の URL の絞り込みだけを替えた行き先。ほかの問い合わせ（?task= など）とフラグメントは残す
export function boardFilterHref(url: Pick<URL, 'href'>, filter: BoardFilter): string {
  const next = new URL(url.href);
  next.searchParams.delete('q');
  next.searchParams.delete('group');
  for (const key of BOARD_FILTER_KEYS) next.searchParams.delete(key);
  for (const [key, value] of new URLSearchParams(boardFilterQuery(filter))) next.searchParams.append(key, value);
  return `${next.pathname}${next.search}${next.hash}`;
}

// 選んだ値の数（検索の語は数えない）。フィルターのボタンに添える
export function selectedCount(filter: BoardFilter): number {
  return BOARD_FILTER_KEYS.reduce((total, key) => total + filter[key].length, 0);
}

export function isBoardFiltering(filter: BoardFilter): boolean {
  return filter.q !== '' || selectedCount(filter) > 0;
}

export function sameBoardFilter(a: BoardFilter, b: BoardFilter): boolean {
  return (
    a.group === b.group && a.q === b.q && BOARD_FILTER_KEYS.every((key) => a[key].join('\n') === b[key].join('\n'))
  );
}

// 1つの値を選ぶか外す。選んでいなければ末尾に足し、選んでいれば外す
export function toggleBoardFilter(filter: BoardFilter, key: BoardFilterKey, value: string): BoardFilter {
  const list = filter[key];
  return { ...filter, [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] };
}

function folded(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function boardFilterValue(task: SprintBoardTask, key: BoardFilterKey): string {
  const ref = key === 'assignee' ? task.assignee : task[key];
  return ref?.id ?? BOARD_FILTER_NONE;
}

export function cardMatches(task: SprintBoardTask, filter: BoardFilter): boolean {
  if (filter.q !== '' && !folded(task.title).includes(folded(filter.q))) return false;
  return BOARD_FILTER_KEYS.every(
    (key) => filter[key].length === 0 || filter[key].includes(boardFilterValue(task, key)),
  );
}

// 列は残し、絞り込みに当たるカードだけを残す。全体の集計には元の列を使う
export function filterColumns(columns: readonly SprintBoardColumn[], filter: BoardFilter): SprintBoardColumn[] {
  if (!isBoardFiltering(filter)) return [...columns];
  return columns.map((column) => ({ ...column, tasks: column.tasks.filter((task) => cardMatches(task, filter)) }));
}

export type BoardChoice = { id: string; label: string; count: number };
export type BoardChoices = Record<BoardFilterKey, BoardChoice[]>;

// ボードのカードから選べる値を作る。担当は名前の順、ストーリー、エピック、区分はボードに初めて出た順（左の列から、列の中は上から）。
// 「無い」（none）は、当たるカードがあるときだけ末尾に置く。label は none のとき空で、画面が辞書の言葉を出す
export function boardChoicesOf(columns: readonly SprintBoardColumn[]): BoardChoices {
  const maps = Object.fromEntries(BOARD_FILTER_KEYS.map((key) => [key, new Map<string, BoardChoice>()])) as Record<
    BoardFilterKey,
    Map<string, BoardChoice>
  >;
  for (const task of columns.flatMap((column) => column.tasks)) {
    for (const key of BOARD_FILTER_KEYS) {
      const ref = key === 'assignee' ? task.assignee : task[key];
      const id = ref?.id ?? BOARD_FILTER_NONE;
      const label = ref === null ? '' : 'name' in ref ? ref.name : ref.title;
      const choice = maps[key].get(id);
      if (choice) choice.count += 1;
      else maps[key].set(id, { id, label, count: 1 });
    }
  }
  const ordered = (key: BoardFilterKey): BoardChoice[] => {
    const list = [...maps[key].values()];
    const none = list.filter((choice) => choice.id === BOARD_FILTER_NONE);
    const named = list.filter((choice) => choice.id !== BOARD_FILTER_NONE);
    if (key === 'assignee') named.sort((a, b) => a.label.localeCompare(b.label, 'ja') || a.id.localeCompare(b.id));
    return [...named, ...none];
  };
  return {
    assignee: ordered('assignee'),
    story: ordered('story'),
    epic: ordered('epic'),
    category: ordered('category'),
  };
}

// 今のボードに無い値（消えたストーリー、別のボードのリンク、誤った ID）を外す。removed は値を外した条件
export function prunedBoardFilter(
  filter: BoardFilter,
  choices: BoardChoices,
): { filter: BoardFilter; removed: BoardFilterKey[] } {
  const removed: BoardFilterKey[] = [];
  const next: BoardFilter = { ...filter };
  for (const key of BOARD_FILTER_KEYS) {
    const known = new Set(choices[key].map((choice) => choice.id));
    const kept = filter[key].filter((value) => known.has(value));
    if (kept.length !== filter[key].length) {
      removed.push(key);
      next[key] = kept;
    }
  }
  return { filter: next, removed };
}

// 追加の行で作るタスクを入れるストーリー。ストーリーを1つだけ選んでいるときのそのストーリー（「無い」は除く）
export function storyForCreate(filter: BoardFilter): string | null {
  const [only, ...rest] = filter.story;
  return only !== undefined && rest.length === 0 && only !== BOARD_FILTER_NONE ? only : null;
}

// 可視カードだけから決めた直前のカードを、全体の並びにも適用する。
// 非表示カードを落とさず、APIに送る after_task_id と同じ位置へ置く。
export function applyFilteredMove(
  columns: readonly SprintBoardColumn[],
  taskId: string,
  columnId: string,
  afterTaskId: string | null | undefined,
): SprintBoardColumn[] {
  const task = columns.flatMap((column) => column.tasks).find((item) => item.id === taskId);
  if (task === undefined) return [...columns];
  return columns.map((column) => {
    const tasks = column.tasks.filter((item) => item.id !== taskId);
    if (column.id !== columnId) return { ...column, tasks };
    const index =
      afterTaskId === undefined
        ? tasks.length
        : afterTaskId === null
          ? 0
          : tasks.findIndex((item) => item.id === afterTaskId) + 1;
    tasks.splice(index, 0, task);
    return { ...column, tasks };
  });
}
