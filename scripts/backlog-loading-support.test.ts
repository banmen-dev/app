import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BacklogBrowserChecks, collectBacklogReadiness } from './backlog-loading-support.ts';

test('木の操作が失敗しても並行する選択肢の待ちを回収する', async () => {
  const primaryError = new Error('button timeout');
  const choicesError = new Error('choices timeout');
  let rejectChoices!: (error: Error) => void;
  let settled = false;
  const pending = collectBacklogReadiness(
    Promise.reject(primaryError),
    new Promise((_, reject) => {
      rejectChoices = reject;
    }),
  );
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  rejectChoices(choicesError);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primaryError, choicesError]);
    return true;
  });
});
test('木の操作と選択肢を独立した時点として返す', async () => {
  assert.deepEqual(await collectBacklogReadiness(Promise.resolve(100), Promise.resolve(80)), [100, 80]);
});
test('選択肢が先に失敗しても木の操作待ちを回収する', async () => {
  let rejectMain!: (error: Error) => void;
  const pending = collectBacklogReadiness(
    new Promise((_, reject) => {
      rejectMain = reject;
    }),
    Promise.reject(new Error('choices')),
  );
  const checked = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((entry: Error) => entry.message),
      ['main', 'choices'],
    );
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  rejectMain(new Error('main'));
  await checked;
});

for (const name of ['backlog-tree', 'category-repository-list', 'experience-team-total']) {
  test(`${name}のHTTP200でも不正JSONを成功にしない`, async () => {
    const checks = new BacklogBrowserChecks();
    checks.response(`/api/bench/${name}`, 200, async () => ({}));
    await assert.rejects(checks.assertSuccess(), /応答/);
  });
}
test('従のJSON解析完了を待ち、解析失敗を検出する', async () => {
  const checks = new BacklogBrowserChecks();
  let fail!: (error: Error) => void;
  const response = new Promise<unknown>((_, reject) => {
    fail = reject;
  });
  checks.response('/api/bench/category-repository-list', 200, () => response);
  const pending = checks.assertSuccess();
  fail(new Error('broken JSON'));
  await assert.rejects(pending, /JSON/);
});
test('通信、HTTPエラー、画面例外を正常試行に混ぜない', async () => {
  for (const kind of ['network', 'http', 'page']) {
    const checks = new BacklogBrowserChecks();
    if (kind === 'network') checks.requestFailed('/api/bench/experience-team-total', 'reset');
    if (kind === 'http') checks.response('/api/bench/workspace', 403, async () => ({}));
    if (kind === 'page') checks.pageError('rejection');
    await assert.rejects(checks.assertSuccess());
  }
});
test('正常な従2件を検証し次の試行も受け付ける', async () => {
  const checks = new BacklogBrowserChecks();
  checks.response('/api/bench/category-repository-list', 200, async () => ({ categories: [], repositories: [] }));
  checks.response('/api/bench/experience-team-total', 200, async () => ({ total: 0 }));
  await checks.assertSuccess();
  await checks.assertSuccess();
});
