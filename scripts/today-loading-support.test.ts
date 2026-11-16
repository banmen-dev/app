import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { finishTodayBenchmark, preserveTodayBuild, TodayBrowserChecks } from './today-loading-support.ts';

test('結果保存と1つ目の停止が失敗しても残る停止・一時D1削除を行う', async () => {
  const calls: string[] = [];
  await assert.rejects(
    finishTodayBenchmark(() => {
      throw new Error('disk full');
    }, [
      () => {
        calls.push('browser');
        throw new Error('already closed');
      },
      () => {
        calls.push('worker');
      },
      () => {
        calls.push('database');
      },
    ]),
    AggregateError,
  );
  assert.deepEqual(calls, ['browser', 'worker', 'database']);
});
for (const existing of [true, false])
  test(`計測ビルドを残さず元のbuildの${existing ? '内容' : '不在'}を復元する`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'today-build-test-'));
    try {
      const output = path.join(dir, 'build');
      if (existing) {
        mkdirSync(output);
        writeFileSync(path.join(output, 'index.html'), 'production');
      }
      const restore = preserveTodayBuild(output, path.join(dir, 'backup'));
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, 'index.html'), 'benchmark C');
      restore();
      restore();
      assert.equal(existsSync(output), existing);
      if (existing) assert.equal(readFileSync(path.join(output, 'index.html'), 'utf8'), 'production');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test('first-steps の通信失敗を正常試行に加えない', async () => {
  const checks = new TodayBrowserChecks();
  checks.requestFailed('/api/bench/first-steps', 'net::ERR_ABORTED');
  await assert.rejects(checks.assertSuccess(), /ERR_ABORTED/);
});
for (const body of [null, { role: 'unknown', steps: [] }, { role: 'member', steps: 'broken' }])
  test('HTTP200でも不正な従のJSONを正常試行に加えない', async () => {
    const checks = new TodayBrowserChecks();
    checks.response('/api/bench/first-steps', 200, async () => body);
    await assert.rejects(checks.assertSuccess(), /応答/);
  });
test('本文の読み取り失敗・非200・ページ例外も正常試行に加えない', async () => {
  for (const failure of ['body', 'http', 'page']) {
    const checks = new TodayBrowserChecks();
    if (failure === 'body')
      checks.response('/api/bench/first-steps', 200, async () => {
        throw new Error('invalid JSON');
      });
    if (failure === 'http') checks.response('/api/bench/first-steps', 500, async () => ({}));
    if (failure === 'page') checks.pageError('unhandled rejection');
    await assert.rejects(checks.assertSuccess());
  }
});
test('正常な主と従は全応答の検証後に成功する', async () => {
  const checks = new TodayBrowserChecks();
  checks.response('/api/bench/today', 200, async () => ({ tasks: [], sprint_goals: [] }));
  checks.response('/api/bench/first-steps', 200, async () => ({ role: null, steps: [] }));
  await checks.assertSuccess();
});
