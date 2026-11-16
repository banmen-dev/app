import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayFixtureAt, todayLoadingFixture } from './today-loading-fixture.ts';

test('指定したfixtureの日時を正規化し、同じ入力から同じSQLを作る', () => {
  const at = todayFixtureAt('2026-11-16T21:35:24.317+09:00');
  assert.equal(at.toISOString(), '2026-11-16T12:35:24.317Z');
  const sql = todayLoadingFixture(at);
  assert.equal(sql, todayLoadingFixture(new Date('2026-11-16T12:35:24.317Z')));
  assert.ok(sql.includes("'2026-11-16T12:35:24.317Z'"));
  assert.ok(sql.includes("THEN '2026-11-16' END"));
});
for (const value of ['', 'not-a-date', '2026-99-99T00:00:00Z', '2026-02-31T00:00:00Z', '1', '2026-11-16T12:00:00'])
  test(`不正なfixture日時を拒否する: ${JSON.stringify(value)}`, () => {
    assert.throws(() => todayFixtureAt(value), /fixture-at/);
  });

test('うるう日の有効なISO日時は受け入れる', () => {
  assert.equal(todayFixtureAt('2024-02-29T23:00:00Z').toISOString(), '2024-02-29T23:00:00.000Z');
});
