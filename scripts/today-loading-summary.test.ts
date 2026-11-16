import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { summarizeToday, type TodayReport } from './today-loading-summary.ts';

function fixture(): TodayReport {
  const p: TodayReport = { runs: 20, rounds: 2, completedAt: '2026-11-16T00:00:00.000Z', api: [], browser: [] };
  for (const round of [1, 2])
    for (let condition = 0; condition < 6; condition++)
      for (const reverse of [false, true]) {
        for (let run = 1; run <= 20; run++) {
          for (const variant of ['A', 'B', 'C'] as const)
            p.api.push({ round, case: condition, reverse, variant, primary: run, load: run, total: run });
          for (const entry of ['direct', 'navigation', 'invalidate'] as const)
            for (const variant of ['B', 'C'] as const)
              p.browser.push({
                round,
                case: condition,
                reverse,
                entry,
                variant,
                primary: 10,
                load: 20,
                secondary: 30,
                shell: 0,
                ready: 1000,
                hasTask: condition < 2 || condition === 3,
              });
        }
      }
  return p;
}
function improve(p: TodayReport, condition = 0, route = 'direct', round?: number) {
  for (const x of p.browser)
    if (
      x.case === condition &&
      x.entry === route &&
      !x.reverse &&
      x.variant === 'C' &&
      (round === undefined || x.round === round)
    )
      x.ready = 900;
}
test('nearest-rankで20個のp95は19番目、全セルを集計する', () => {
  const r = summarizeToday(fixture());
  assert.deepEqual(r.apiRows[0]!.primary, { p50: 10, p95: 19 });
  assert.equal(r.apiRows.length, 72);
  assert.equal(r.browserRows.length, 144);
  assert.equal(r.comparisons.length, 72);
  assert.equal(r.eligible, false);
});
test('境界の100msかつ10%が一般メンバーの同一経路で2巡再現したら採用する', () => {
  const p = fixture();
  improve(p);
  const r = summarizeToday(p);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.qualifyingPaths, [{ case: 0, entry: 'direct' }]);
});
for (const kind of [
  'one-round',
  'different-path',
  'admin',
  'reverse',
  'milliseconds',
  'percentage',
  'regression',
] as const)
  test(`${kind}: 単発・対照・片方の閾値・他条件悪化では採用しない`, () => {
    const p = fixture();
    if (kind === 'one-round') improve(p, 0, 'direct', 1);
    if (kind === 'different-path') {
      improve(p, 0, 'direct', 1);
      improve(p, 0, 'navigation', 2);
    }
    if (kind === 'admin') improve(p, 4);
    if (kind === 'reverse')
      for (const x of p.browser) if (x.case === 0 && x.reverse && x.variant === 'C') x.ready = 800;
    if (kind === 'milliseconds') {
      improve(p);
      for (const x of p.browser)
        if (x.case === 0 && !x.reverse && x.entry === 'direct') x.ready = x.variant === 'B' ? 500 : 450;
    }
    if (kind === 'percentage') {
      improve(p);
      for (const x of p.browser)
        if (x.case === 0 && !x.reverse && x.entry === 'direct') x.ready = x.variant === 'B' ? 2000 : 1900;
    }
    if (kind === 'regression') {
      improve(p);
      for (const x of p.browser) if (x.case === 5 && x.variant === 'C') x.ready = 1100;
    }
    assert.equal(summarizeToday(p).eligible, false);
  });
for (const kind of ['missing', 'duplicate', 'round', 'unfinished', 'error', 'negative', 'nan', 'zero', 'task'] as const)
  test(`${kind}: 不完全・異常な結果から採用判定を作らない`, () => {
    const p = fixture();
    if (kind === 'missing') p.browser.pop();
    if (kind === 'duplicate') p.browser[p.browser.length - 1] = { ...p.browser[0]! };
    if (kind === 'round') p.api[0]!.round = 3;
    if (kind === 'unfinished') (p as Partial<TodayReport>).completedAt = undefined;
    if (kind === 'error') (p as Record<string, unknown>).error = 'failed';
    if (kind === 'negative') p.api[0]!.primary = -1;
    if (kind === 'nan') p.browser[0]!.ready = NaN;
    if (kind === 'zero') for (const x of p.browser) x.ready = 0;
    if (kind === 'task') p.browser[0]!.hasTask = false;
    assert.throws(() => summarizeToday(p));
  });
test('保存済みの正式生データから文書の全表と保留判断を再現する', () => {
  const raw = gunzipSync(readFileSync(new URL('../docs/today-loading-samples.json.gz', import.meta.url)));
  const r = summarizeToday(JSON.parse(raw.toString('utf8')));
  assert.equal(r.eligible, false);
  assert.equal(r.qualifyingPaths.length, 0);
  assert.equal(r.worsening.length, 4);
  const doc = readFileSync(new URL('../docs/today-loading-browser-results.md', import.meta.url), 'utf8');
  assert.equal(doc.slice(doc.indexOf('## API')).trim(), r.markdown.trim());
});
