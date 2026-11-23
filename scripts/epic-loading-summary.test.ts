import assert from 'node:assert/strict';
import { test } from 'node:test';
import { epicEntries, epicVariants, summarizeEpic, type EpicSample } from './epic-loading-summary.ts';

function report() {
  const samples: EpicSample[] = [];
  for (const round of [1, 2])
    for (const entry of epicEntries)
      for (const variant of epicVariants)
        for (let trial = 0; trial < 20; trial++) {
          const ready = entry === 'navigation' && variant === 'C' ? 400 : 500;
          samples.push({
            round,
            entry,
            variant,
            trial,
            ready,
            display: 350,
            primary: 150,
            definitions: variant === 'C' ? null : 250,
            afterEditClick: 50,
            drawerEpic: ready + 30,
            drawerDefinitions: ready + 50,
            choices: ready + 70,
            shell: null,
          });
        }
  return { samples, runs: 20, rounds: 2, completedAt: '2026-11-22T00:00:00Z', refreshVerified: true };
}

test('同じ経路で100ms以上かつ10%以上の操作開始の改善が2巡再現した場合にだけ実装へ進める', () => {
  const value = report();
  const accepted = summarizeEpic(value);
  assert.equal(accepted.decision, 'implement');
  assert.deepEqual(accepted.reproduced, ['navigation']);

  for (const row of value.samples) {
    if (row.round === 2 && row.entry === 'navigation' && row.variant === 'C') row.ready += 1;
  }
  assert.equal(summarizeEpic(value).decision, 'hold');
});

test('別の経路で区分の選択が悪化した場合は操作開始の改善が再現しても保留する', () => {
  const value = report();
  for (const row of value.samples) {
    if (row.round === 2 && row.entry === 'reload' && row.variant === 'C') {
      row.choices += 100;
      row.afterEditClick += 100;
    }
  }
  const result = summarizeEpic(value);
  assert.equal(result.decision, 'hold');
  assert.deepEqual(result.reproduced, ['navigation']);
  assert.deepEqual(
    result.regressions.map(({ round, entry, field, delta }) => ({ round, entry, field, delta })),
    [{ round: 2, entry: 'reload', field: 'choices', delta: 100 }],
  );
});

test('欠測・重複・不正な時系列と保存後の再取得が未確認のデータを拒否する', () => {
  const value = report();
  const [first, ...remaining] = value.samples;
  assert.throws(() => summarizeEpic({ ...value, samples: remaining }), /試行が不足/);
  assert.throws(() => summarizeEpic({ ...value, samples: [...value.samples, first] }), /重複/);
  assert.throws(() => summarizeEpic({ ...value, samples: [{ ...first, definitions: 500 }, ...remaining] }), /時系列/);
  assert.throws(() => summarizeEpic({ ...value, refreshVerified: false }));
});

test('温め後の少数試行は再集計できるが採否を出さない', () => {
  const value = report();
  const result = summarizeEpic({ ...value, runs: 1, samples: value.samples.filter((row) => row.trial === 0) });
  assert.equal(result.decision, 'preview');
});

test('絶対値を満たしても割合が10%未満の短縮は保留する', () => {
  const value = report();
  for (const row of value.samples) {
    if (row.entry !== 'navigation') continue;
    const offset = (row.variant === 'C' ? 1090 : 1200) - row.ready;
    row.ready += offset;
    row.choices += offset;
    row.drawerEpic += offset;
    row.drawerDefinitions += offset;
  }
  assert.equal(summarizeEpic(value).decision, 'hold');
});

test('20回のp95には最小から19番目を使う', () => {
  const value = report();
  for (const row of value.samples) {
    if (row.entry !== 'navigation' || row.variant !== 'C') continue;
    const offset = row.trial < 18 ? -10 : row.trial === 18 ? 0 : 150;
    row.ready += offset;
    row.choices += offset;
    row.drawerEpic += offset;
    row.drawerDefinitions += offset;
  }
  const result = summarizeEpic(value);
  const cell = result.cells.find(({ entry, variant }) => entry === 'navigation' && variant === 'C');
  assert.deepEqual(cell?.timings.ready, { p50: 390, p95: 400, count: 20 });
  assert.equal(result.decision, 'implement');
});
