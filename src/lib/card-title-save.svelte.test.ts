import { expect, test, vi } from 'vitest';
import type { TaskDetail } from '../shared/operations/task/index.ts';
import type { ApiResult } from './api.ts';
import { saveCardTitle, type CardTitleTarget } from './card-title-save.ts';

function targetWith(overrides: Partial<CardTitleTarget> = {}): CardTitleTarget {
  return {
    workspaceId: 'w1',
    slug: 'aoba',
    onpatch: vi.fn(),
    onStale: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
}

const saved = (title: string): ApiResult<{ task: TaskDetail }> => ({
  ok: true,
  data: { task: { title } as TaskDetail },
});

test('通ったら、送る前に受け取った配線で題を直し、送っている間の題を戻す', async () => {
  const target = targetWith();
  const sending: (string | null)[] = [];
  const send = vi.fn(async () => saved('直した題'));
  await saveCardTitle({
    target,
    taskId: 't1',
    title: '直した題',
    base: '前の題',
    imported: false,
    setSending: (title) => sending.push(title),
    send,
  });
  expect(send).toHaveBeenCalledWith(
    { workspace_id: 'w1', task_id: 't1', title: '直した題', expected: { title: '前の題' } },
    'aoba',
  );
  expect(target.onpatch).toHaveBeenCalledWith('t1', { title: '直した題' });
  expect(target.onSaved).not.toHaveBeenCalled();
  expect(sending).toEqual(['直した題', null]);
});

test('通った後に題の直しが失敗しても、送っている間の題を戻し、呼び出し元へ例外を投げない', async () => {
  const target = targetWith({
    onpatch: () => {
      throw new TypeError('配線が外れた');
    },
  });
  const sending: (string | null)[] = [];
  await expect(
    saveCardTitle({
      target,
      taskId: 't1',
      title: '直した題',
      base: '前の題',
      imported: false,
      setSending: (title) => sending.push(title),
      send: async () => saved('直した題'),
    }),
  ).resolves.toBeUndefined();
  expect(sending).toEqual(['直した題', null]);
});

test('断られたら、送っている間の題を戻し、送る前に受け取った配線で知らせて読み直す', async () => {
  const target = targetWith();
  const sending: (string | null)[] = [];
  await saveCardTitle({
    target,
    taskId: 't1',
    title: '直した題',
    base: '前の題',
    imported: false,
    setSending: (title) => sending.push(title),
    send: async () => ({ ok: false, status: 409, error: { code: 'workspace_closed', message: '' } }),
  });
  expect(sending).toEqual(['直した題', null]);
  expect(target.onStale).toHaveBeenCalledTimes(1);
  expect(target.onSaved).toHaveBeenCalledTimes(1);
  expect(target.onpatch).not.toHaveBeenCalled();
});

test('送る処理が例外を投げても、送っている間の題を戻す', async () => {
  const sending: (string | null)[] = [];
  await expect(
    saveCardTitle({
      target: targetWith(),
      taskId: 't1',
      title: '直した題',
      base: '前の題',
      imported: false,
      setSending: (title) => sending.push(title),
      send: async () => {
        throw new Error('通信の失敗');
      },
    }),
  ).rejects.toThrow('通信の失敗');
  expect(sending).toEqual(['直した題', null]);
});
