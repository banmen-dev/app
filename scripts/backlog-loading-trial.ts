import type { ReadResponse } from './loading-trial.ts';

export type BacklogMode = 'A' | 'B' | 'C';
export type BacklogOperation = 0 | 1;
export type BacklogReadResponse = Pick<ReadResponse, 'finishedAt' | 'body' | 'validate'>;

// 0: 木、1: 区分・リポジトリ。検証と全応答の回収後にだけ次の試行へ進む。
export async function backlogTrial(
  mode: BacklogMode,
  reverse: boolean,
  read: (operation: BacklogOperation) => Promise<BacklogReadResponse>,
  now: () => number = () => performance.now(),
) {
  const started = now();
  const order: BacklogOperation[] = mode === 'A' ? [0] : reverse ? [1, 0] : [0, 1];
  const pending = new Map<BacklogOperation, Promise<BacklogReadResponse>>();
  for (const operation of order) {
    // 同期 throw も rejected Promise として保存し、残る要求の開始と回収を保証する。
    try {
      pending.set(operation, read(operation));
    } catch (error) {
      pending.set(operation, Promise.reject(error));
    }
  }
  const all = Promise.allSettled(pending.values());
  let ready: number;
  if (mode === 'B') {
    await all;
    ready = now() - started;
  } else {
    await pending.get(0)!.catch(() => undefined);
    ready = now() - started;
  }
  const results = await all;
  const total = now() - started;
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason);
    else {
      try {
        result.value.validate(result.value.body);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'バックログの計測応答が失敗しました');
  const completed = async (operation: BacklogOperation) =>
    pending.has(operation) ? (await pending.get(operation)!).finishedAt - started : null;
  const primary = (await completed(0))!;
  return {
    primary,
    definitions: await completed(1),
    ready,
    total,
  };
}
