import { describe, expect, test } from 'vitest';
import type { SprintBoardColumn, SprintBoardTask } from '../shared/operations/sprint/index.ts';
import { planCardMove } from './sprint-board.ts';
import { resolveSprintDrop } from './sprint-drop.ts';
import {
  applyFilteredMove,
  BOARD_FILTER_NONE,
  boardChoicesOf,
  boardFilterHref,
  boardFilterOf,
  emptyBoardFilter,
  filterColumns,
  isBoardFiltering,
  prunedBoardFilter,
  selectedCount,
  storyForCreate,
  toggleBoardFilter,
  type BoardFilter,
} from './board-filter.ts';
const card = (id: string, story: string | null): SprintBoardTask => ({
  id,
  title: id,
  story: story === null ? null : { id: story, title: story },
  epic: null,
  category: null,
  points: 3,
  assignee: null,
  completed_at: null,
  reopenable: false,
  due_on: null,
  repository: null,
  can_delete: false,
  is_imported: false,
});
const columns: SprintBoardColumn[] = [
  {
    id: 'a',
    name: '出発',
    is_done: false,
    wip_limit: null,
    tasks: [card('hidden', 'other'), card('first', 'story'), card('root', null), card('second', 'story')],
  },
  { id: 'b', name: '作業', is_done: false, wip_limit: null, tasks: [card('third', 'story'), card('tail', 'other')] },
];
const ids = (list: SprintBoardColumn[]) => list.map((column) => column.tasks.map((task) => task.id));
const by = (patch: Partial<BoardFilter>): BoardFilter => ({ ...emptyBoardFilter, ...patch });
const storyColumns = (list: SprintBoardColumn[], story: string) => filterColumns(list, by({ story: [story] }));
describe('ストーリー絞り込み', () => {
  test('親が同じカードだけを残し、空の列も残す。全体を変更しない', () => {
    expect(ids(storyColumns(columns, 'story'))).toEqual([['first', 'second'], ['third']]);
    expect(ids(storyColumns(columns, 'absent'))).toEqual([[], []]);
    expect(ids(filterColumns(columns, emptyBoardFilter))).toEqual(ids(columns));
    expect(columns[0]!.tasks).toHaveLength(4);
  });
  test('URLのtaskと他のクエリとフラグメントを残して絞り込みを切り替える', () => {
    const url = new URL('https://example.test/a/board?task=task&story=old#mark');
    expect(boardFilterHref(url, by({ story: ['new'] }))).toBe('/a/board?task=task&story=new#mark');
    expect(boardFilterHref(url, emptyBoardFilter)).toBe('/a/board?task=task#mark');
    expect(url.searchParams.get('story')).toBe('old');
  });
  test('キーで上下に動かす直前は可視カードから決め、非表示カードを失わない', () => {
    const visible = storyColumns(columns, 'story');
    const plan = planCardMove(visible, 'first', 'down');
    expect(plan).toMatchObject({ kind: 'moved', afterTaskId: 'second' });
    if (plan?.kind !== 'moved') throw new Error('移動計画がない');
    expect(ids(applyFilteredMove(columns, 'first', plan.column.id, plan.afterTaskId))).toEqual([
      ['hidden', 'root', 'second', 'first'],
      ['third', 'tail'],
    ]);
    expect(columns[0]!.tasks).toHaveLength(4);
  });
  test('絞ったドラッグで見えているカードの前へ入り、隠れたカードは残る', () => {
    const drop = resolveSprintDrop(storyColumns(columns, 'story'), 'second', { kind: 'card', id: 'third' }, 'before');
    expect(drop?.plan).toMatchObject({ kind: 'moved', afterTaskId: null });
    if (drop?.plan.kind !== 'moved') throw new Error('移動計画がない');
    expect(ids(applyFilteredMove(columns, 'second', drop.plan.column.id, drop.plan.afterTaskId))).toEqual([
      ['hidden', 'first', 'root'],
      ['second', 'third', 'tail'],
    ]);
  });
  test('隣列末尾への移動は全体の末尾に置き、表示すると可視列末尾になる', () => {
    expect(ids(applyFilteredMove(columns, 'second', 'b', undefined))).toEqual([
      ['hidden', 'first', 'root'],
      ['third', 'tail', 'second'],
    ]);
  });
});

const person = (id: string, name: string) => ({ id, name });
function rich(id: string, extra: Partial<SprintBoardTask>): SprintBoardTask {
  return { ...card(id, null), ...extra };
}
const richColumns: SprintBoardColumn[] = [
  {
    id: 'a',
    name: '出発',
    is_done: false,
    wip_limit: null,
    tasks: [
      rich('t1', { title: 'Login 画面を直す', assignee: person('u2', '辻'), story: { id: 's1', title: '入口' } }),
      rich('t2', {
        title: '見積もりを送る',
        assignee: person('u1', '青木'),
        story: { id: 's2', title: '見積もり' },
        epic: { id: 'e1', title: '会員' },
        category: { id: 'c1', name: '保守' },
      }),
      rich('t3', { title: 'ＬＯＧＩＮの文言', category: { id: 'c2', name: '開発' } }),
    ],
  },
  {
    id: 'b',
    name: '作業',
    is_done: false,
    wip_limit: null,
    tasks: [
      rich('t4', {
        title: '請求の確認',
        assignee: person('u1', '青木'),
        story: { id: 's2', title: '見積もり' },
        epic: { id: 'e1', title: '会員' },
        category: { id: 'c1', name: '保守' },
      }),
    ],
  },
];

describe('ボードの絞り込み', () => {
  test('URL から読み、同じ値は1つにまとめ、空の値を捨て、検索の語の前後の空白を除く', () => {
    const filter = boardFilterOf(
      new URLSearchParams('q=%20login%20&assignee=u1&assignee=u1&assignee=&assignee=none&story=s1&epic=e1&category=c1'),
    );
    expect(filter).toEqual({ q: 'login', assignee: ['u1', 'none'], story: ['s1'], epic: ['e1'], category: ['c1'] });
    expect(boardFilterOf(new URLSearchParams(`q=${'あ'.repeat(300)}`)).q).toHaveLength(200);
    expect(boardFilterOf(new URLSearchParams())).toEqual(emptyBoardFilter);
  });

  test('検索の語の上限は絵文字の途中で切らない', () => {
    const q = boardFilterOf(new URLSearchParams({ q: `${'a'.repeat(199)}😀😀` })).q;
    expect(q.isWellFormed()).toBe(true);
    expect([...q]).toHaveLength(200);
    expect(q.endsWith('😀')).toBe(true);
  });

  test('同じ条件に 101 個の値を渡すと 100 個で切り、同名の担当は ID の順に並ぶ', () => {
    const params = new URLSearchParams(Array.from({ length: 101 }, (_, i) => ['assignee', `u${i}`]));
    expect(boardFilterOf(params).assignee).toHaveLength(100);
    const twins: SprintBoardColumn[] = [
      {
        id: 'a',
        name: '出発',
        is_done: false,
        wip_limit: null,
        tasks: [rich('x1', { assignee: person('u9', '辻') }), rich('x2', { assignee: person('u1', '辻') })],
      },
    ];
    expect(boardChoicesOf(twins).assignee.map((choice) => choice.id)).toEqual(['u1', 'u9']);
  });

  test('URL に書いて読み直すと同じ絞り込みに戻る', () => {
    const filter = by({ q: '見積 もり', assignee: ['u1', BOARD_FILTER_NONE], category: ['c1'] });
    const href = boardFilterHref(new URL('https://example.test/a/board?task=x'), filter);
    expect(href).toBe('/a/board?task=x&q=%E8%A6%8B%E7%A9%8D+%E3%82%82%E3%82%8A&assignee=u1&assignee=none&category=c1');
    expect(boardFilterOf(new URL(href, 'https://example.test').searchParams)).toEqual(filter);
  });

  test('検索は題の部分一致で、大文字と小文字、全角と半角を区別しない', () => {
    expect(ids(filterColumns(richColumns, by({ q: 'login' })))).toEqual([['t1', 't3'], []]);
    expect(ids(filterColumns(richColumns, by({ q: '見積' })))).toEqual([['t2'], []]);
    expect(ids(filterColumns(richColumns, by({ q: '無い語' })))).toEqual([[], []]);
  });

  test('同じ条件の中は「または」、条件どうしは「かつ」。none は値の無いカードに当たる', () => {
    expect(ids(filterColumns(richColumns, by({ assignee: ['u2', 'u1'] })))).toEqual([['t1', 't2'], ['t4']]);
    expect(ids(filterColumns(richColumns, by({ assignee: [BOARD_FILTER_NONE] })))).toEqual([['t3'], []]);
    expect(ids(filterColumns(richColumns, by({ assignee: ['u1'], q: '請求' })))).toEqual([[], ['t4']]);
    expect(ids(filterColumns(richColumns, by({ epic: ['e1'], category: ['c1'] })))).toEqual([['t2'], ['t4']]);
    expect(ids(filterColumns(richColumns, by({ category: [BOARD_FILTER_NONE] })))).toEqual([['t1'], []]);
    expect(ids(filterColumns(richColumns, by({ story: ['s1', BOARD_FILTER_NONE] })))).toEqual([['t1', 't3'], []]);
  });

  test('選べる値はボードのカードから作り、担当は名前の順、ほかは出た順。無いものは当たるときだけ末尾に置く', () => {
    const choices = boardChoicesOf(richColumns);
    expect(choices.assignee).toEqual([
      { id: 'u1', label: '青木', count: 2 },
      { id: 'u2', label: '辻', count: 1 },
      { id: BOARD_FILTER_NONE, label: '', count: 1 },
    ]);
    expect(choices.story.map((choice) => choice.id)).toEqual(['s1', 's2', BOARD_FILTER_NONE]);
    expect(choices.epic).toEqual([
      { id: 'e1', label: '会員', count: 2 },
      { id: BOARD_FILTER_NONE, label: '', count: 2 },
    ]);
    expect(choices.category.map((choice) => choice.label)).toEqual(['保守', '開発', '']);
    expect(boardChoicesOf([])).toEqual({ assignee: [], story: [], epic: [], category: [] });
  });

  test('今のボードに無い値を外し、外した条件を返す', () => {
    const choices = boardChoicesOf(richColumns);
    const { filter, removed } = prunedBoardFilter(
      by({ q: 'x', assignee: ['u1', 'gone'], story: ['missing'], epic: ['e1'] }),
      choices,
    );
    expect(filter).toEqual(by({ q: 'x', assignee: ['u1'], epic: ['e1'] }));
    expect(removed).toEqual(['assignee', 'story']);
    expect(prunedBoardFilter(by({ assignee: ['u1'] }), choices).removed).toEqual([]);
  });

  test('値を選ぶと足し、もう一度選ぶと外す。数と絞っているかを返す', () => {
    const once = toggleBoardFilter(emptyBoardFilter, 'assignee', 'u1');
    const twice = toggleBoardFilter(once, 'assignee', 'u2');
    expect(twice.assignee).toEqual(['u1', 'u2']);
    expect(toggleBoardFilter(twice, 'assignee', 'u1').assignee).toEqual(['u2']);
    expect(selectedCount(by({ assignee: ['u1'], story: ['s1', 's2'] }))).toBe(3);
    expect(isBoardFiltering(emptyBoardFilter)).toBe(false);
    expect(isBoardFiltering(by({ q: 'x' }))).toBe(true);
    expect(emptyBoardFilter.assignee).toEqual([]);
  });

  test('追加の行で作るタスクの親は、ストーリーを1つだけ選んでいるときだけ', () => {
    expect(storyForCreate(by({ story: ['s1'] }))).toBe('s1');
    expect(storyForCreate(by({ story: ['s1', 's2'] }))).toBeNull();
    expect(storyForCreate(by({ story: [BOARD_FILTER_NONE] }))).toBeNull();
    expect(storyForCreate(emptyBoardFilter)).toBeNull();
  });
});
