import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planLoadingEntries,
  planLoadingFixtures,
  planLoadingVariants,
  summarizePlanLoading,
  type PlanLoadingReport,
  type PlanLoadingSample,
} from './plan-loading-browser-summary.ts';

function report(runs = 20, rounds = 2): PlanLoadingReport {
  const browser: PlanLoadingSample[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (const fixture of planLoadingFixtures) {
      for (const entry of planLoadingEntries) {
        for (const variant of planLoadingVariants) {
          for (let run = runs; run >= 1; run--) {
            const candidate = fixture === 'planned' && entry === 'sprints' && variant === 'C';
            browser.push({
              round,
              run,
              variant,
              entry,
              fixture,
              list: 900 + run,
              operation: fixture === 'empty' ? null : (candidate ? 881 : 981) + run,
              summary: 1200 + run,
            });
          }
        }
      }
    }
  }
  return { runs, rounds, browser };
}

test('操作開始 p95 の短縮が同じ条件と経路の両巡で100msかつ10%に達した場合だけ候補にする', () => {
  const result = summarizePlanLoading(report());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.qualifyingPaths, [{ fixture: 'planned', entry: 'sprints' }]);
  const rows = result.browser.filter((row) => row.round === 1 && row.fixture === 'planned' && row.entry === 'sprints');
  assert.deepEqual(
    rows.map((row) => row.operation),
    [
      { p50: 991, p95: 1000 },
      { p50: 891, p95: 900 },
    ],
  );
  assert.equal(result.comparisons.length, 2 * 4 * (3 * 3 + 2));
  assert.ok(result.browser.filter((row) => row.fixture === 'empty').every((row) => row.operation === null));
});

test('異なる経路・データでの短縮や、終了済みの閲覧だけの短縮で採用しない', () => {
  const input = report();
  for (const sample of input.browser) {
    if (sample.variant !== 'C' || sample.operation === null) continue;
    if (sample.fixture === 'closed') sample.operation -= 200;
    if (sample.round === 2 && sample.fixture === 'planned' && sample.entry === 'sprints') sample.operation += 100;
    if (sample.round === 2 && sample.fixture === 'planned' && sample.entry === 'navigation') sample.operation -= 100;
    if (sample.round === 2 && sample.fixture === 'history' && sample.entry === 'sprints') sample.operation -= 100;
  }
  const result = summarizePlanLoading(input);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.qualifyingPaths, []);
});

test('空の集計表示・終了済みの閲覧・履歴ありの一覧の悪化はそれぞれ採用を止める', () => {
  const input = report();
  for (const sample of input.browser) {
    if (sample.round !== 2 || sample.variant !== 'C' || sample.entry !== 'backlog-tree') continue;
    if (sample.fixture === 'history') sample.list += 100;
    if (sample.fixture === 'empty') sample.summary += 130;
    if (sample.fixture === 'closed' && sample.operation !== null) sample.operation += 100;
  }
  const result = summarizePlanLoading(input);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.qualifyingPaths, [{ fixture: 'planned', entry: 'sprints' }]);
  assert.deepEqual(
    result.regressions.map(({ fixture, metric }) => [fixture, metric]),
    [
      ['history', 'list'],
      ['empty', 'summary'],
      ['closed', 'operation'],
    ],
  );
});

test('丸めると閾値に達する短縮や、絶対値だけが閾値を満たす短縮で採用しない', () => {
  const input = report();
  for (const sample of input.browser) {
    if (sample.fixture !== 'planned' || sample.operation === null) continue;
    if (sample.variant === 'C' && sample.entry === 'sprints') sample.operation += 0.001;
    if (sample.entry === 'direct') sample.operation += sample.variant === 'C' ? 900 : 1000;
  }
  assert.equal(summarizePlanLoading(input).eligible, false);
});

test('予行は集計して保留し、失敗記録がある正式データも保留する', () => {
  const preview = summarizePlanLoading(report(1, 1));
  assert.equal(preview.browser.length, 32);
  assert.equal(preview.eligible, false);
  assert.match(preview.reasons.join(' '), /20試行・独立2巡/);
  const failed = summarizePlanLoading({ ...report(), failures: ['通信失敗'] });
  assert.equal(failed.eligible, false);
  assert.match(failed.reasons.join(' '), /計測の失敗/);
});

test('欠測・重複・範囲外・条件に合わない操作時刻を拒否する', () => {
  const incomplete = report(1, 1);
  incomplete.browser.pop();
  assert.throws(() => summarizePlanLoading(incomplete), /不足/);

  const invalid = report(2, 1);
  const first = invalid.browser[0]!;
  first.run = 1;
  assert.throws(() => summarizePlanLoading(invalid), /重複/);
  first.run = 3;
  assert.throws(() => summarizePlanLoading(invalid), /範囲外/);
  first.run = 2;
  first.operation = null;
  assert.throws(() => summarizePlanLoading(invalid), /条件が一致/);
});
