import { expect, test } from 'vitest';
import type { SprintBoardColumn, SprintBoardTask } from '../shared/operations/sprint/index.ts';
import { boardFilterHref, boardFilterOf, filterColumns } from './board-filter.ts';
import { boardLanesOf } from './board-lanes.ts';

test('グループを切り替えても検索と絞り込みと引き出しのクエリが残る', () => {
  const url = new URL('https://example.test/board?q=検索&assignee=none&task=a&group=story#end');
  const filter = boardFilterOf(url.searchParams);
  expect(filter.group).toBe('story');
  const next = new URL(boardFilterHref(url, { ...filter, group: 'epic' }), url);
  expect(boardFilterOf(next.searchParams)).toMatchObject({ q: '検索', assignee: ['none'], group: 'epic' });
  expect(next.searchParams.get('task')).toBe('a');
  expect(next.hash).toBe('#end');
  expect(boardFilterOf(new URLSearchParams('group=category')).group).toBeUndefined();
});

test('絞り込んだカードを列を保って分け、担当なしは最後に置く', () => {
  const card = (id: string, title: string, assignee: SprintBoardTask['assignee']): SprintBoardTask => ({
    id,
    title,
    assignee,
    points: null,
    completed_at: null,
    reopenable: false,
    story: null,
    epic: null,
    category: null,
    due_on: null,
    repository: null,
    can_delete: false,
    is_imported: false,
  });
  const haruka = { id: 'u1', name: 'ハルカ' };
  const minato = { id: 'u2', name: 'ミナト' };
  const sample: SprintBoardColumn[] = [
    {
      id: 'todo',
      name: '未着手',
      is_done: false,
      tasks: [card('3', '履歴の検索', minato), card('1', '履歴の一覧', haruka), card('2', '障害時の連絡手順', null)],
    },
    {
      id: 'working',
      name: '作業中',
      is_done: false,
      tasks: [card('4', '履歴の保存', minato)],
    },
  ];
  const filter = boardFilterOf(new URLSearchParams('group=assignee'));
  const lanes = boardLanesOf(filterColumns(sample, filter), 'assignee');
  expect(lanes.map(({ id, count }) => [id, count])).toEqual([
    [haruka.id, 1],
    [minato.id, 2],
    ['none', 1],
  ]);
  expect(lanes[1]?.columns.map((column) => column.tasks.length)).toEqual([1, 1]);
  expect(boardLanesOf(filterColumns(sample, { ...filter, q: '障害時' }), 'assignee').map(({ id }) => id)).toEqual([
    'none',
  ]);
});
