import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { backlogCases } from './backlog-loading-fixture.ts';
import { backlogEntries, summarizeBacklog, type BacklogReport } from './backlog-loading-summary.ts';

test('正式生データから全表と3経路の短縮・10組の悪化による保留判断を再現する', () => {
  const raw = gunzipSync(readFileSync(new URL('../docs/backlog-loading-samples.json.gz', import.meta.url)));
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    'd4cda2c9226ba943615aad64536ebb9e883a7588ba0316dd13bfc7d602b6e14c',
  );
  const { markdown, ...result } = summarizeBacklog(JSON.parse(raw.toString('utf8')));
  assert.equal(result.eligible, false);
  assert.deepEqual(result.qualifyingPaths, [
    { case: 0, entry: 'navigation' },
    { case: 1, entry: 'direct' },
    { case: 2, entry: 'direct' },
  ]);
  assert.equal(result.worsening.length, 10);
  assert.deepEqual(
    result,
    JSON.parse(readFileSync(new URL('../docs/backlog-loading-decision.json', import.meta.url), 'utf8')),
  );
  const document = readFileSync(new URL('../docs/backlog-loading-browser-results.md', import.meta.url), 'utf8');
  assert.equal(document.slice(document.indexOf('## API')).trim(), markdown.trim());
});

test('計測時の実行コード6件を保存済みハッシュと照合できる', () => {
  const samples = JSON.parse(
    gunzipSync(readFileSync(new URL('../docs/backlog-loading-samples.json.gz', import.meta.url))).toString('utf8'),
  );
  const snapshot = JSON.parse(
    gunzipSync(readFileSync(new URL('../docs/backlog-loading-source.json.gz', import.meta.url))).toString('utf8'),
  );
  assert.equal(snapshot.base, samples.base);
  const runtimeFiles = Object.keys(samples.inputHashes)
    .filter((name) => !name.endsWith('.test.ts'))
    .sort();
  assert.equal(runtimeFiles.length, 6);
  assert.deepEqual(Object.keys(snapshot.files).sort(), runtimeFiles);
  for (const [name, source] of Object.entries(snapshot.files)) {
    assert.ok(typeof source === 'string');
    assert.equal(createHash('sha256').update(source).digest('hex'), samples.inputHashes[name]);
  }
});

function fixture(): BacklogReport {
  const report: BacklogReport = {
    runs: 20,
    rounds: 2,
    completedAt: '2026-11-17T00:00:00.000Z',
    api: [],
    browser: [],
  };
  for (const round of [1, 2])
    for (let condition = 0; condition < backlogCases.length; condition++)
      for (const reverse of [false, true])
        for (let trial = 0; trial < report.runs; trial++) {
          for (const variant of ['A', 'B', 'C'] as const)
            report.api.push({
              round,
              case: condition,
              reverse,
              variant,
              trial,
              primary: trial + 1,
              load: trial + 2,
              total: trial + 3,
              definitions: variant === 'A' ? null : trial + 1,
              experience: variant === 'A' ? null : trial + 2,
            });
          for (const entry of backlogEntries)
            for (const variant of ['B', 'C'] as const)
              report.browser.push({
                round,
                case: condition,
                reverse,
                entry,
                variant,
                trial,
                primary: 10,
                load: variant === 'B' ? 50 : 20,
                definitions: 30,
                experience: 40,
                choices: 100,
                shell: 0,
                ready: 1000,
                hasTask: backlogCases[condition]!.hasTask,
              });
        }
  return report;
}
function improve(p: BacklogReport, condition = 0, entry = 'direct', round?: number) {
  for (const x of p.browser)
    if (
      x.case === condition &&
      x.entry === entry &&
      !x.reverse &&
      x.variant === 'C' &&
      (round === undefined || x.round === round)
    )
      x.ready = 900;
}

test('3巡中2巡の再現を採用し、全巡の悪化を検査する', () => {
  const report = fixture();
  report.rounds = 3;
  report.api.push(...report.api.filter((sample) => sample.round === 1).map((sample) => ({ ...sample, round: 3 })));
  report.browser.push(
    ...report.browser.filter((sample) => sample.round === 1).map((sample) => ({ ...sample, round: 3 })),
  );
  improve(report, 0, 'direct', 1);
  improve(report, 0, 'direct', 2);
  const result = summarizeBacklog(report);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.qualifyingPaths, [{ case: 0, entry: 'direct' }]);
  assert.equal(result.comparisons.length, 120);
  for (const sample of report.browser)
    if (
      sample.round === 3 &&
      sample.case === 0 &&
      !sample.reverse &&
      sample.entry === 'direct' &&
      sample.variant === 'C'
    )
      sample.ready = 1100;
  assert.equal(summarizeBacklog(report).eligible, false);
});

test('全5条件・4経路・正逆2順・2巡をnearest-rankで集計する', () => {
  const report = fixture();
  const result = summarizeBacklog(report);
  assert.deepEqual(result.apiRows[0]!.primary, { p50: 10, p95: 19 });
  assert.equal(result.apiRows.length, 60);
  assert.equal(result.browserRows.length, 160);
  assert.equal(result.comparisons.length, 80);
  assert.equal(result.eligible, false);
  assert.equal(result.apiRows[0]!.definitions, null);
  assert.deepEqual(result.apiRows[1]!.definitions, { p50: 10, p95: 19 });
  assert.deepEqual(result.browserRows[0]!.choices, { p50: 100, p95: 100 });
  assert.match(result.markdown, /区分・リポジトリ完了/);
  assert.match(result.markdown, /選択肢利用可能/);
});
for (const condition of [0, 1, 2])
  for (const entry of backlogEntries)
    test(`一般メンバー条件${condition}/${entry}で100msかつ10%が2巡再現すれば採用する`, () => {
      const p = fixture();
      improve(p, condition, entry);
      const result = summarizeBacklog(p);
      assert.equal(result.eligible, true);
      assert.deepEqual(result.qualifyingPaths, [{ case: condition, entry }]);
    });

for (const kind of [
  'one-round',
  'different-path',
  'different-case',
  'reverse',
  'milliseconds',
  'percentage',
  'api-only',
] as const)
  test(`${kind}: 単発・別条件・逆順・片方の閾値・API差だけは採用しない`, () => {
    const p = fixture();
    if (kind === 'one-round') improve(p, 0, 'direct', 1);
    if (kind === 'different-path') {
      improve(p, 0, 'direct', 1);
      improve(p, 0, 'filter', 2);
    }
    if (kind === 'different-case') {
      improve(p, 0, 'direct', 1);
      improve(p, 1, 'direct', 2);
    }
    if (kind === 'reverse') for (const x of p.browser) if (x.reverse && x.variant === 'C') x.ready = 800;
    if (kind === 'milliseconds' || kind === 'percentage') {
      for (const x of p.browser)
        if (x.case === 0 && x.entry === 'direct' && !x.reverse)
          x.ready = kind === 'milliseconds' ? (x.variant === 'B' ? 500 : 450) : x.variant === 'B' ? 2000 : 1900;
    }
    if (kind === 'api-only')
      for (const x of p.api)
        if (x.variant === 'B') {
          x.load = 3000;
          x.total = 3000;
        }
    assert.equal(summarizeBacklog(p).eligible, false);
  });

for (const condition of [3, 4])
  test(`空表示の条件${condition}の短縮を操作開始の採用根拠にしない`, () => {
    const p = fixture();
    improve(p, condition);
    const result = summarizeBacklog(p);
    assert.equal(result.eligible, false);
    assert.equal(result.qualifyingPaths.length, 0);
    assert.equal(
      result.comparisons.filter((x) => x.case === condition).some((x) => x.pass),
      false,
    );
  });

for (const condition of [1, 3, 4])
  for (const reverse of [false, true])
    test(`他条件${condition}/${reverse ? '逆' : '正'}の100msかつ10%悪化があれば採用しない`, () => {
      const p = fixture();
      improve(p);
      for (const x of p.browser)
        if (x.case === condition && x.reverse === reverse && x.variant === 'C' && x.entry === 'filter') x.ready = 1100;
      const result = summarizeBacklog(p);
      assert.equal(result.eligible, false);
      assert.equal(result.qualifyingPaths.length, 1);
      assert.equal(result.worsening.length, 2);
    });

for (const kind of [
  'missing',
  'extra',
  'duplicate-within-cell',
  'duplicate-other-cell',
  'api-duplicate',
  'round',
  'case',
  'trial',
  'unknown-route',
  'unfinished',
  'error',
  'negative',
  'nan',
  'ready-zero',
  'c-ready-zero',
  'choices-zero',
  'task',
  'api-a-secondary',
  'api-b-null',
  'primary-after-load',
  'load-after-ready',
  'definitions-after-choices',
  'api-after-total',
  'too-few-runs',
  'too-few-rounds',
] as const)
  test(`${kind}: 欠測・重複・異常値・条件不一致を拒否する`, () => {
    const p = fixture();
    if (kind === 'missing') p.browser.pop();
    if (kind === 'extra') p.browser.push({ ...p.browser[0]! });
    if (kind === 'duplicate-within-cell') p.browser[8]!.trial = p.browser[0]!.trial;
    if (kind === 'duplicate-other-cell') p.browser[p.browser.length - 1] = { ...p.browser[0]! };
    if (kind === 'api-duplicate') p.api[3]!.trial = 0;
    if (kind === 'round') p.api[0]!.round = 3;
    if (kind === 'case') p.api[0]!.case = 5;
    if (kind === 'trial') p.browser[0]!.trial = 20;
    if (kind === 'unknown-route') (p.browser[0] as Record<string, unknown>).entry = 'other';
    if (kind === 'unfinished') (p as Partial<BacklogReport>).completedAt = undefined;
    if (kind === 'error') (p as Record<string, unknown>).error = 'failed';
    if (kind === 'negative') p.api[0]!.primary = -1;
    if (kind === 'nan') p.browser[0]!.ready = NaN;
    if (kind === 'ready-zero') for (const x of p.browser) x.ready = 0;
    if (kind === 'c-ready-zero') for (const x of p.browser) if (x.variant === 'C') x.ready = 0;
    if (kind === 'choices-zero') p.browser[0]!.choices = 0;
    if (kind === 'task') p.browser[0]!.hasTask = false;
    if (kind === 'api-a-secondary') p.api[0]!.definitions = 1;
    if (kind === 'api-b-null') p.api[1]!.experience = null;
    if (kind === 'primary-after-load') p.browser[0]!.primary = 60;
    if (kind === 'load-after-ready') p.browser[0]!.load = 2000;
    if (kind === 'definitions-after-choices') p.browser[0]!.definitions = 2000;
    if (kind === 'api-after-total') p.api[1]!.definitions = 2000;
    if (kind === 'too-few-runs') p.runs = 19;
    if (kind === 'too-few-rounds') p.rounds = 1;
    assert.throws(() => summarizeBacklog(p));
  });

test('正常な生データの配列順が替わっても全表・採否は一致する', () => {
  const p = fixture();
  improve(p, 2, 'filter');
  const first = summarizeBacklog(p);
  p.api.reverse();
  p.browser.reverse();
  assert.deepEqual(summarizeBacklog(p), first);
});

for (const stream of ['api', 'browser'] as const)
  for (const secondary of ['definitions', 'experience'] as const)
    test(`${stream} B: ${secondary}がload復帰より遅い不可能な計測値を拒否する`, () => {
      const p = fixture();
      const sample = p[stream].find((x) => x.variant === 'B')!;
      sample[secondary] = sample.load + 1;
      assert.throws(() => summarizeBacklog(p));
    });

test('Cでは従の完了がload復帰より遅くても合法として集計する', () => {
  const p = fixture();
  for (const x of p.api)
    if (x.variant === 'C') {
      x.definitions = x.load + 1;
      x.experience = x.load + 2;
      x.total = x.load + 3;
    }
  for (const x of p.browser)
    if (x.variant === 'C') {
      x.definitions = x.load + 1;
      x.experience = x.load + 2;
    }
  assert.doesNotThrow(() => summarizeBacklog(p));
});
