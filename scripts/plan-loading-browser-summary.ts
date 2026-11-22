// node scripts/plan-loading-browser-summary.ts <生データ.json> [出力の接頭辞]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { percentile } from './loading-stats.ts';

export const planLoadingEntries = ['direct', 'navigation', 'sprints', 'backlog-tree'] as const;
export const planLoadingFixtures = ['history', 'planned', 'empty', 'closed'] as const;
export const planLoadingVariants = ['B', 'C'] as const;
const metrics = ['list', 'operation', 'summary'] as const;
const entryNames = {
  direct: 'URL直接表示',
  navigation: '画面内遷移',
  sprints: 'app:sprints の再読み取り',
  'backlog-tree': 'app:backlog-tree の再読み取り',
};
const fixtureNames = { history: '履歴あり', planned: '先のスプリントあり', empty: '空', closed: '終了済み' };
const metricNames = { list: '一覧表示', operation: '操作開始', summary: '集計表示' };

const ms = z.number().finite().nonnegative();
const sampleSchema = z.object({
  round: z.int().positive(),
  run: z.int().positive(),
  variant: z.enum(planLoadingVariants),
  entry: z.enum(planLoadingEntries),
  fixture: z.enum(planLoadingFixtures),
  list: ms,
  operation: ms.nullable(),
  summary: ms,
});
const reportSchema = z.object({
  runs: z.int().positive(),
  rounds: z.int().positive(),
  browser: z.array(sampleSchema),
  failures: z.array(z.unknown()).optional(),
  error: z.unknown().optional(),
});
export type PlanLoadingSample = z.input<typeof sampleSchema>;
export type PlanLoadingReport = z.input<typeof reportSchema>;
type Comparison = {
  round: number;
  fixture: PlanLoadingSample['fixture'];
  entry: PlanLoadingSample['entry'];
  metric: (typeof metrics)[number];
  baseline: number;
  candidate: number;
  savingMs: number;
  savingPercent: number | null;
  improvement: boolean;
  regression: boolean;
};

function cellKey(
  round: number,
  fixture: PlanLoadingSample['fixture'],
  entry: PlanLoadingSample['entry'],
  variant: PlanLoadingSample['variant'],
) {
  return `${round}/${fixture}/${entry}/${variant}`;
}

function distribution(values: number[]) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function format(value: ReturnType<typeof distribution> | null) {
  return value === null ? '—' : `${value.p50.toFixed(2)} / ${value.p95.toFixed(2)}`;
}

export function summarizePlanLoading(value: unknown) {
  const report = reportSchema.parse(value);
  const samplesPerRound =
    planLoadingEntries.length * planLoadingFixtures.length * planLoadingVariants.length * report.runs;
  if (report.browser.length !== report.rounds * samplesPerRound) throw new Error('試行数が不足または過剰です');

  const groups = new Map<string, Map<number, PlanLoadingSample>>();
  for (const sample of report.browser) {
    if (sample.round > report.rounds || sample.run > report.runs) throw new Error('巡または試行番号が範囲外です');
    if ((sample.operation === null) !== (sample.fixture === 'empty'))
      throw new Error('操作開始の有無とワークスペースの条件が一致しません');
    const key = cellKey(sample.round, sample.fixture, sample.entry, sample.variant);
    const group = groups.get(key) ?? new Map<number, PlanLoadingSample>();
    if (group.has(sample.run)) throw new Error('同じ条件の試行番号が重複しています');
    group.set(sample.run, sample);
    groups.set(key, group);
  }

  function summarizeCell(
    round: number,
    fixture: PlanLoadingSample['fixture'],
    entry: PlanLoadingSample['entry'],
    variant: PlanLoadingSample['variant'],
  ) {
    const group = groups.get(cellKey(round, fixture, entry, variant));
    if (group?.size !== report.runs) throw new Error('条件ごとの試行数が不正です');
    const samples = [...group.values()];
    const operation = samples.flatMap((sample) => (sample.operation === null ? [] : [sample.operation]));
    return {
      round,
      fixture,
      entry,
      variant,
      list: distribution(samples.map((sample) => sample.list)),
      operation: operation.length === 0 ? null : distribution(operation),
      summary: distribution(samples.map((sample) => sample.summary)),
    };
  }

  const browser = [];
  const comparisons: Comparison[] = [];
  for (let round = 1; round <= report.rounds; round++) {
    for (const fixture of planLoadingFixtures) {
      for (const entry of planLoadingEntries) {
        const b = summarizeCell(round, fixture, entry, 'B');
        const c = summarizeCell(round, fixture, entry, 'C');
        browser.push(b, c);
        for (const metric of metrics) {
          const baseline = b[metric]?.p95;
          const candidate = c[metric]?.p95;
          if (baseline === undefined || candidate === undefined) continue;
          const savingMs = baseline - candidate;
          comparisons.push({
            round,
            fixture,
            entry,
            metric,
            baseline,
            candidate,
            savingMs,
            savingPercent: baseline === 0 ? null : (savingMs / baseline) * 100,
            improvement: savingMs >= 100 && savingMs * 10 >= baseline,
            regression: -savingMs >= 100 && -savingMs * 10 >= baseline,
          });
        }
      }
    }
  }

  const qualifyingPaths = (['history', 'planned'] as const).flatMap((fixture) =>
    planLoadingEntries.flatMap((entry) => {
      const operation = comparisons.filter(
        (item) => item.fixture === fixture && item.entry === entry && item.metric === 'operation',
      );
      return operation.length >= 2 && operation.every((item) => item.improvement) ? [{ fixture, entry }] : [];
    }),
  );
  const regressions = comparisons.filter((item) => item.regression);
  const reasons: string[] = [];
  if (report.runs !== 20 || report.rounds !== 2) reasons.push('正式計測には各条件20試行・独立2巡が必要です。');
  if (report.failures?.length || report.error != null) reasons.push('計測の失敗が記録されています。');
  if (!qualifyingPaths.length)
    reasons.push('編集可能な同一条件・同一経路で操作開始 p95 の改善が独立2巡で再現していません。');
  if (regressions.length) reasons.push('正式指標に100ms以上かつ10%以上の悪化が見つかりました。');
  const eligible = reasons.length === 0;

  const markdown = [
    '## ブラウザ計測（ms、p50 / p95）',
    '',
    '空のワークスペースの操作開始は対象外。終了済みのワークスペースでは閲覧操作を測る。',
    '',
    '| 巡 | データ | 経路 | 方式 | 一覧表示 | 操作開始 | 集計表示 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
    ...browser.map(
      (row) =>
        `| ${row.round} | ${fixtureNames[row.fixture]} | ${entryNames[row.entry]} | ${row.variant} | ${format(row.list)} | ${format(row.operation)} | ${format(row.summary)} |`,
    ),
    '',
    '## 現行 B と候補 C の比較（p95）',
    '',
    '短縮量は B − C。採否は丸め前の値で判定する。',
    '',
    '| 巡 | データ | 経路 | 指標 | B (ms) | C (ms) | 短縮量 (ms) | 短縮率 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...comparisons.map((row) => {
      const percentage = row.savingPercent === null ? '—' : `${row.savingPercent.toFixed(2)}%`;
      return `| ${row.round} | ${fixtureNames[row.fixture]} | ${entryNames[row.entry]} | ${metricNames[row.metric]} | ${row.baseline.toFixed(2)} | ${row.candidate.toFixed(2)} | ${row.savingMs.toFixed(2)} | ${percentage} |`;
    }),
    '',
    '## 採否',
    '',
    eligible ? 'ブラウザ計測の数値基準を満たした。' : '画面変更を保留する。',
    ...reasons.map((reason) => `- ${reason}`),
    '',
  ].join('\n');
  return {
    runs: report.runs,
    rounds: report.rounds,
    eligible,
    qualifyingPaths,
    regressions,
    reasons,
    browser,
    comparisons,
    markdown,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, outputPrefix, ...extra] = process.argv.slice(2);
  if (!input || extra.length)
    throw new Error('使い方: node scripts/plan-loading-browser-summary.ts <生データ.json> [出力の接頭辞]');
  const { markdown, ...summary } = summarizePlanLoading(JSON.parse(readFileSync(input, 'utf8')));
  if (outputPrefix) {
    writeFileSync(`${outputPrefix}.json`, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(`${outputPrefix}.md`, markdown, { flag: 'wx' });
  } else {
    process.stdout.write(markdown);
  }
}
