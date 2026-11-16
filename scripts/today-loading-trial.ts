import type { ReadResponse } from './loading-trial.ts';

export type TodayMode = 'A' | 'B' | 'C';

// A: 主だけ。B: 並列開始して両方待つ。C: 並列開始して主だけ待つ。
// ready は成功時に load が返せる時点で、描画・認証処理の計測ではない。
// 次の試行には全応答の検証を済ませてから進み、従の要求を持ち越さない。
export async function todayTrial(
  mode: TodayMode,
  reverse: boolean,
  read: (secondary: boolean) => Promise<ReadResponse>,
  now: () => number = () => performance.now(),
) {
  const started = now();
  const pending = new Map<boolean, Promise<ReadResponse>>();
  for (const secondary of mode === 'A' ? [false] : reverse ? [true, false] : [false, true]) {
    pending.set(secondary, read(secondary));
  }
  // エラー時も両方を回収し、未処理の rejection や次の試行への混入を避ける。
  const all = Promise.allSettled(pending.values());
  let ready: number;
  if (mode === 'B') {
    await all;
    ready = now() - started;
  } else {
    try {
      await pending.get(false)!;
      ready = now() - started;
    } catch (error) {
      await all;
      throw error;
    }
  }
  const results = await all;
  const total = now() - started;
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    result.value.validate(result.value.body);
  }
  const primary = (await pending.get(false)!).finishedAt - started;
  return { primary, ready, total, wait: Math.max(0, total - primary) };
}
