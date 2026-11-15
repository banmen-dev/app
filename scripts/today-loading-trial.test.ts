import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { todayTrial, type TodayMode } from './today-loading-trial.ts';
import type { ReadResponse } from './loading-trial.ts';

for (const mode of ['A', 'B', 'C'] satisfies TodayMode[]) {
  for (const reverse of [false, true]) {
    test(`${mode}/${reverse}: 主と従の待ち、開始順、検証時点を区別する`, { timeout: 5000 }, async () => {
      let clock = 100;
      const called: boolean[] = [];
      const validated: number[] = [];
      const resolvers = new Map<boolean, (value: ReadResponse) => void>();
      const running = todayTrial(
        mode,
        reverse,
        (secondary) => {
          called.push(secondary);
          return new Promise((resolve) => resolvers.set(secondary, resolve));
        },
        () => clock,
      );
      assert.deepEqual(called, mode === 'A' ? [false] : reverse ? [true, false] : [false, true]);
      const finish = (secondary: boolean, at: number) => {
        clock = at;
        resolvers.get(secondary)!({
          ms: at - 100,
          finishedAt: at,
          secondary,
          body: null,
          validate: () => {
            validated.push(clock);
          },
        });
      };
      finish(false, 110);
      await setImmediate();
      if (mode !== 'A') {
        assert.deepEqual(validated, []);
        finish(true, 150);
      }
      const result = await running;
      assert.equal(result.primary, 10);
      assert.equal(result.ready, mode === 'B' ? 50 : 10);
      assert.equal(result.total, mode === 'A' ? 10 : 50);
      assert.equal(result.wait, mode === 'A' ? 0 : 40);
      assert.deepEqual(validated, mode === 'A' ? [110] : [150, 150]);
    });
  }
}

test('C: 従が先に終わっても主を待ち、追加待ちは0になる', async () => {
  let clock = 0;
  const result = await todayTrial(
    'C',
    true,
    async (secondary) => {
      clock = secondary ? 5 : 20;
      return { ms: clock, finishedAt: clock, secondary, body: null, validate() {} };
    },
    () => clock,
  );
  assert.deepEqual(result, { primary: 20, ready: 20, total: 20, wait: 0 });
});

test('C: 主の失敗後も従を回収してから失敗を返す', { timeout: 5000 }, async () => {
  let finishSecondary!: (value: ReadResponse) => void;
  const running = todayTrial('C', false, (secondary) =>
    secondary
      ? new Promise((resolve) => {
          finishSecondary = resolve;
        })
      : Promise.reject(new Error('primary failed')),
  );
  let settled = false;
  const checked = assert.rejects(running, /primary failed/).then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  finishSecondary({ ms: 0, finishedAt: 0, secondary: true, body: null, validate() {} });
  await checked;
});

test('C: 従の取得失敗や出力検証の失敗を成功として集計しない', async () => {
  await assert.rejects(
    todayTrial('C', false, async (secondary) => {
      if (secondary) throw new Error('secondary failed');
      return { ms: 0, finishedAt: 0, secondary, body: null, validate() {} };
    }),
    /secondary failed/,
  );
  await assert.rejects(
    todayTrial('C', false, async (secondary) => ({
      ms: 0,
      finishedAt: 0,
      secondary,
      body: null,
      validate() {
        throw new Error('invalid output');
      },
    })),
    /invalid output/,
  );
});

for (const failedSecondary of [false, true]) {
  test(
    `B: ${failedSecondary ? '従' : '主'}が先に失敗しても残る応答を回収してから拒否する`,
    { timeout: 5000 },
    async () => {
      let finishRemaining!: (value: ReadResponse) => void;
      const running = todayTrial('B', false, (secondary) =>
        secondary === failedSecondary
          ? Promise.reject(new Error('request failed'))
          : new Promise((resolve) => {
              finishRemaining = resolve;
            }),
      );
      let settled = false;
      const checked = assert.rejects(running, /request failed/).then(() => {
        settled = true;
      });
      await setImmediate();
      assert.equal(settled, false);
      finishRemaining({ ms: 0, finishedAt: 0, secondary: !failedSecondary, body: null, validate() {} });
      await checked;
      assert.equal(settled, true);
    },
  );
}
