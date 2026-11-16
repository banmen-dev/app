import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  backlogTrial,
  type BacklogMode,
  type BacklogOperation,
  type BacklogReadResponse,
} from './backlog-loading-trial.ts';

for (const mode of ['A', 'B', 'C'] satisfies BacklogMode[]) {
  for (const reverse of [false, true]) {
    test(`${mode}/${reverse}: 全要求を並列開始し、主・各従・load・全応答を区別する`, { timeout: 5000 }, async () => {
      let clock = 100;
      const called: BacklogOperation[] = [];
      const validated: BacklogOperation[] = [];
      const resolvers = new Map<BacklogOperation, (response: BacklogReadResponse) => void>();
      const running = backlogTrial(
        mode,
        reverse,
        (operation) => {
          called.push(operation);
          return new Promise((resolve) => resolvers.set(operation, resolve));
        },
        () => clock,
      );
      assert.deepEqual(called, mode === 'A' ? [0] : reverse ? [2, 1, 0] : [0, 1, 2]);
      const finish = (operation: BacklogOperation, at: number) => {
        clock = at;
        resolvers.get(operation)!({
          finishedAt: at,
          body: { operation },
          validate: () => {
            validated.push(operation);
          },
        });
      };
      finish(0, 110);
      await setImmediate();
      if (mode !== 'A') {
        assert.deepEqual(validated, []);
        finish(1, 130);
        await setImmediate();
        finish(2, 150);
      }
      assert.deepEqual(await running, {
        primary: 10,
        definitions: mode === 'A' ? null : 30,
        teamTotal: mode === 'A' ? null : 50,
        ready: mode === 'B' ? 50 : 10,
        total: mode === 'A' ? 10 : 50,
      });
      assert.deepEqual(validated, called);
    });
  }
}

test('C: 従が先に終わる場合も主を待つ', async () => {
  let clock = 0;
  const result = await backlogTrial(
    'C',
    true,
    async () => {
      clock += 10;
      return { finishedAt: clock, body: null, validate() {} };
    },
    () => clock,
  );
  assert.deepEqual(result, { primary: 30, definitions: 20, teamTotal: 10, ready: 30, total: 30 });
});

for (const mode of ['B', 'C'] satisfies BacklogMode[]) {
  for (const failed of [0, 1, 2] satisfies BacklogOperation[]) {
    test(`${mode}: ${failed}の失敗後も残る応答と不正な出力を全て回収する`, { timeout: 5000 }, async () => {
      const resolvers: (() => void)[] = [];
      let validated = 0;
      const original = new Error('read failed');
      const invalid = new Error('invalid output');
      const running = backlogTrial(mode, false, (operation) => {
        if (operation === failed) throw original;
        return new Promise((resolve) =>
          resolvers.push(() =>
            resolve({
              finishedAt: 1,
              body: null,
              validate() {
                validated++;
                throw invalid;
              },
            }),
          ),
        );
      });
      let settled = false;
      const checked = assert
        .rejects(running, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 3);
          assert.ok(error.errors.includes(original));
          assert.equal(error.errors.filter((item) => item === invalid).length, 2);
          return true;
        })
        .then(() => {
          settled = true;
        });
      await setImmediate();
      assert.equal(settled, false);
      assert.equal(resolvers.length, 2, '同期throwでも後続の要求を開始する');
      resolvers[0]();
      await setImmediate();
      assert.equal(settled, false);
      resolvers[1]();
      await checked;
      assert.equal(validated, 2);
    });
  }
}

test('C: 非同期の通信失敗を正常試行にしない', async () => {
  const network = new Error('network');
  await assert.rejects(
    backlogTrial('C', false, async (operation) => {
      if (operation === 1) throw network;
      return { finishedAt: 1, body: null, validate() {} };
    }),
    (error: unknown) => error instanceof AggregateError && error.errors.includes(network),
  );
});
