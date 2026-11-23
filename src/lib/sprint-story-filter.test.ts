import { describe, expect, test } from 'vitest';
import type { SprintBoardColumn, SprintBoardTask } from '../shared/operations/sprint/index.ts';
import { planCardMove } from './sprint-board.ts';
import { resolveSprintDrop } from './sprint-drop.ts';
import { applyStoryMove, storyColumns, storyHref } from './sprint-story-filter.ts';
const card = (id: string, story: string | null): SprintBoardTask => ({
  id,
  title: id,
  story: story === null ? null : { id: story, title: story },
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
    tasks: [card('hidden', 'other'), card('first', 'story'), card('root', null), card('second', 'story')],
  },
  { id: 'b', name: '作業', is_done: false, tasks: [card('third', 'story'), card('tail', 'other')] },
];
const ids = (list: SprintBoardColumn[]) => list.map((column) => column.tasks.map((task) => task.id));
describe('ストーリー絞り込み', () => {
  test('親が同じカードだけを残し、空の列も残す。全体を変更しない', () => {
    expect(ids(storyColumns(columns, 'story'))).toEqual([['first', 'second'], ['third']]);
    expect(ids(storyColumns(columns, 'absent'))).toEqual([[], []]);
    expect(ids(storyColumns(columns, null))).toEqual(ids(columns));
    expect(columns[0]!.tasks).toHaveLength(4);
  });
  test('URLのtaskと他のクエリとフラグメントを残して絞り込みを切り替える', () => {
    const url = new URL('https://example.test/a/sprint?task=task&story=old#mark');
    expect(storyHref(url, 'new')).toBe('/a/sprint?task=task&story=new#mark');
    expect(storyHref(url, null)).toBe('/a/sprint?task=task#mark');
    expect(url.searchParams.get('story')).toBe('old');
  });
  test('キーで上下に動かす直前は可視カードから決め、非表示カードを失わない', () => {
    const visible = storyColumns(columns, 'story');
    const plan = planCardMove(visible, 'first', 'down');
    expect(plan).toMatchObject({ kind: 'moved', afterTaskId: 'second' });
    if (plan?.kind !== 'moved') throw new Error('移動計画がない');
    expect(ids(applyStoryMove(columns, 'first', plan.column.id, plan.afterTaskId))).toEqual([
      ['hidden', 'root', 'second', 'first'],
      ['third', 'tail'],
    ]);
    expect(columns[0]!.tasks).toHaveLength(4);
  });
  test('絞ったドラッグで見えているカードの前へ入り、隠れたカードは残る', () => {
    const drop = resolveSprintDrop(storyColumns(columns, 'story'), 'second', { kind: 'card', id: 'third' }, 'before');
    expect(drop?.plan).toMatchObject({ kind: 'moved', afterTaskId: null });
    if (drop?.plan.kind !== 'moved') throw new Error('移動計画がない');
    expect(ids(applyStoryMove(columns, 'second', drop.plan.column.id, drop.plan.afterTaskId))).toEqual([
      ['hidden', 'first', 'root'],
      ['second', 'third', 'tail'],
    ]);
  });
  test('隣列末尾への移動は全体の末尾に置き、表示すると可視列末尾になる', () => {
    expect(ids(applyStoryMove(columns, 'second', 'b', undefined))).toEqual([
      ['hidden', 'first', 'root'],
      ['third', 'tail', 'second'],
    ]);
  });
});
