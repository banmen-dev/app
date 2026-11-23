import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import type { SprintBoardTask } from '../../shared/operations/sprint/index.ts';
import SprintCard from './SprintCard.svelte';

const task: SprintBoardTask = {
  id: 'x',
  title: '確認する',
  points: 1,
  assignee: null,
  completed_at: '2026-11-16T00:00:00.000Z',
  reopenable: false,
  story: null,
  repository: null,
  due_on: null,
  can_delete: false,
};
const html = (reopenable: boolean, writable = true) =>
  render(SprintCard, {
    props: {
      task: { ...task, reopenable },
      href: '/aoba/w/test/board?task=x',
      edges: null,
      writable,
      clock: { today: '2026-11-16', weekStart: 1 },
      hintId: 'hint',
      onmove: () => {},
    },
  }).body;

test('戻せない完了カードは見えない要約で状態を伝え、試すメニューは残す', () => {
  const body = html(false);
  expect(body).toMatch(/class="visually-hidden" id="card-x-summary">[^<]*完了を戻せません/);
  expect(body).toContain('aria-describedby="card-x-summary hint"');
  expect(body).toContain('前の列へ（完了を戻す）');
});

test('戻せるカードの要約には拒否状態を足さない', () => {
  expect(html(true)).not.toContain('完了を戻せません');
});

test('読み取り専用は要約への選択配線も操作メニューも出さない', () => {
  const body = html(false, false);
  expect(body).not.toContain('card-x-summary');
  expect(body).not.toContain('row-menu-btn');
});
