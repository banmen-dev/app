import { expect, test } from 'vitest';
import { cardTitleFailure, taskTitleMessage } from './task-title.ts';

test('題の検査は、空と長すぎを文にし、使える題は null', () => {
  expect(taskTitleMessage('  ')).not.toBeNull();
  expect(taskTitleMessage('あ'.repeat(201))).not.toBeNull();
  expect(taskTitleMessage(' 直した題 ')).toBeNull();
});

test('断られた題の保存の理由を、状態と code で分ける', () => {
  const fail = (status: number, code = 'conflict', details?: unknown) =>
    cardTitleFailure({ ok: false, status, error: { code, message: '', details } });
  expect(fail(409, 'conflict', { reason: 'stale', current: { title: '先' } })).toEqual({
    message: expect.stringContaining('ほかの人が同時に直した'),
    stale: false,
  });
  expect(fail(409).message).toContain('取り込んだ');
  expect(fail(409, 'workspace_closed').stale).toBe(true);
  expect(fail(401).stale).toBe(true);
  expect(fail(404).message).toContain('タスク');
  expect(fail(400).message).toContain('入力を受け付けられません');
  expect(fail(0).message).toContain('保存できませんでした');
});
