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
  is_imported: false,
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

const attrs = {
  slug: 'aoba',
  workspaceId: 'w1',
  meId: 'u1',
  loadedAt: 0,
  onpatch: () => {},
  onSaved: () => {},
  onStale: () => {},
};
const editable = (patch: Partial<SprintBoardTask>) =>
  render(SprintCard, {
    props: {
      task: { ...task, completed_at: null, ...patch },
      href: '/aoba/w/test/board?task=x',
      edges: { top: true, bottom: true, prev: true, next: false, completes: false },
      writable: true,
      clock: { today: '2026-11-16', weekStart: 1 },
      onmove: () => {},
      attrs,
    },
  }).body;

test('書き込めるカードは、ポイントと担当をチップにし、題の横に鉛筆を置く', () => {
  const body = editable({ points: 3, assignee: { id: 'u2', name: 'ハルカ' } });
  expect(body).toContain('aria-label="ポイント: 3 pt"');
  expect(body).toContain('aria-label="担当: ハルカ"');
  // 担当のチップは絞り込みの窓を開く
  expect(body).toContain('aria-haspopup="dialog"');
  expect(body).toContain('aria-label="タイトルを直す: 確認する"');
  expect(body).not.toMatch(/card-edit-btn[^>]*aria-disabled/);
});

test('完了したカードのチップと鉛筆は押せず、理由が読める', () => {
  const body = editable({ completed_at: '2026-11-16T00:00:00.000Z' });
  expect(body).toContain('このタスクは完了になっているため、ポイントは直せません。');
  expect(body).toContain('このタスクは完了になっているため、担当は替えられません。');
  expect(body).toContain('このタスクは完了になっているため、タイトルは直せません。');
  expect(body).toMatch(/card-edit-btn[^>]*aria-disabled="true"/);
});

test('取り込んだタスクの鉛筆は押せず、理由が読める。チップは押せる', () => {
  const body = editable({ is_imported: true });
  expect(body).toContain('取り込んだタスクのタイトルは直せません。');
  expect(body).toMatch(/card-edit-btn[^>]*aria-disabled="true"/);
  expect(body).toContain('aria-haspopup="menu"');
});

test('書き込めないカードは、チップと鉛筆を出さない', () => {
  const body = html(false, false);
  expect(body).not.toContain('chip-btn');
  expect(body).not.toContain('card-edit-btn');
});
