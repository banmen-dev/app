import { expect, test } from 'vitest';
import { SAMPLE_BOARD } from '../../e2e/sprint-fixture.ts';
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
  const filter = boardFilterOf(new URLSearchParams('group=assignee'));
  const columns = filterColumns(SAMPLE_BOARD.columns, filter);
  const lanes = boardLanesOf(columns, 'assignee');
  expect(lanes.map(({ id, count }) => [id, count])).toEqual([
    [SAMPLE_BOARD.columns[0]!.tasks[0]!.assignee!.id, 1],
    [SAMPLE_BOARD.columns[1]!.tasks[0]!.assignee!.id, 2],
    ['none', 1],
  ]);
  expect(lanes[1]?.columns.map((column) => column.tasks.length)).toEqual([0, 1, 0, 1]);
  expect(boardLanesOf(filterColumns(columns, { ...filter, q: '障害時' }), 'assignee').map(({ id }) => id)).toEqual([
    'none',
  ]);
});
