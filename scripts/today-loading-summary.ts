// node scripts/today-loading-summary.ts <結果.json[.gz]> <出力の接頭辞>
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { percentile } from './loading-stats.ts';
import { todayCases } from './today-loading-fixture.ts';

const ms = z.number().finite().nonnegative();
const common = {
  round: z.number().int().min(1),
  case: z
    .number()
    .int()
    .min(0)
    .max(todayCases.length - 1),
  reverse: z.boolean(),
  primary: ms,
  load: ms,
};
const entry = z.enum(['direct', 'navigation', 'invalidate']);
const reportSchema = z.object({
  runs: z.number().int().min(20),
  rounds: z.number().int().min(2),
  completedAt: z.string().datetime(),
  error: z.undefined().optional(),
  api: z.array(z.object({ ...common, variant: z.enum(['A', 'B', 'C']), total: ms })),
  browser: z.array(
    z.object({
      ...common,
      variant: z.enum(['B', 'C']),
      entry,
      secondary: ms,
      ready: ms.positive(),
      shell: ms,
      hasTask: z.boolean(),
    }),
  ),
});
export type TodayReport = z.input<typeof reportSchema>;
const entries = ['direct', 'navigation', 'invalidate'] as const;
const names = todayCases.map((x) => `${x.role} / ${x.pending ? 'pending' : 'completed'}`);
const generalCases = todayCases.flatMap((x, index) => (x.role === 'member' ? [index] : []));
const entryNames = { direct: '直接表示', navigation: '画面内遷移', invalidate: '再読み取り' };
const key = (round: number, condition: number, reverse: boolean, variant: string, route = '') =>
  JSON.stringify([round, condition, reverse, variant, route]);
const distribution = (values: number[]) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
const formatted = (value: { p50: number; p95: number }) => `${value.p50.toFixed(2)} / ${value.p95.toFixed(2)}`;

export function summarizeToday(value: unknown) {
  const report = reportSchema.parse(value);
  if (
    report.api.length !== report.rounds * todayCases.length * 2 * 3 * report.runs ||
    report.browser.length !== report.rounds * todayCases.length * 2 * 2 * 3 * report.runs
  )
    throw new Error('試行数が不足または過剰です');
  const apiGroups = new Map<string, typeof report.api>();
  const browserGroups = new Map<string, typeof report.browser>();
  for (const sample of report.api) {
    if (sample.round > report.rounds) throw new Error('未知の巡です');
    const id = key(sample.round, sample.case, sample.reverse, sample.variant);
    const group = apiGroups.get(id) ?? [];
    group.push(sample);
    apiGroups.set(id, group);
  }
  for (const sample of report.browser) {
    if (sample.round > report.rounds || sample.hasTask !== todayCases[sample.case]!.hasTask)
      throw new Error('巡またはタスクの条件が不正です');
    const id = key(sample.round, sample.case, sample.reverse, sample.variant, sample.entry);
    const group = browserGroups.get(id) ?? [];
    group.push(sample);
    browserGroups.set(id, group);
  }
  const apiRows = [];
  const browserRows = [];
  const comparisons = [];
  const apiLines = [
    '\n## API（ms、p50 / p95）\n',
    '| 巡 | 条件 | 発行順 | 方式 | 主完了 | load相当 | 全応答 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
  ];
  const readyLines = [
    '\n## ブラウザの操作可能／空の面の表示（ms、p50 / p95）\n',
    'leader / pending と admin の2条件は空の面の表示であり、タスク操作開始ではない。差は B の p95 − C の p95。負は C の方が遅い。分位点同士の比較であり、同一試行内の短縮ではない。\n',
    '| 巡 | 条件 | 発行順 | 経路 | B | C | p95差 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
  ];
  const completionLines = [
    '\n## ブラウザの完了時点（ms、p50 / p95）\n',
    '| 巡 | 条件 | 発行順 | 経路 | 方式 | 主完了 | 従完了 | load復帰 | 枠のAPI完了 |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (let round = 1; round <= report.rounds; round++)
    for (let condition = 0; condition < todayCases.length; condition++)
      for (const reverse of [false, true]) {
        const order = reverse ? '逆' : '正';
        for (const variant of ['A', 'B', 'C']) {
          const samples = apiGroups.get(key(round, condition, reverse, variant));
          if (samples?.length !== report.runs) throw new Error('APIセルの試行数が不正です');
          const row = {
            round,
            case: condition,
            reverse,
            variant,
            primary: distribution(samples.map((x) => x.primary)),
            load: distribution(samples.map((x) => x.load)),
            total: distribution(samples.map((x) => x.total)),
          };
          apiRows.push(row);
          apiLines.push(
            `| ${round} | ${names[condition]} | ${order} | ${variant} | ${formatted(row.primary)} | ${formatted(row.load)} | ${formatted(row.total)} |`,
          );
        }
        for (const route of entries) {
          const stats = new Map<string, ReturnType<typeof distribution>>();
          for (const variant of ['B', 'C']) {
            const samples = browserGroups.get(key(round, condition, reverse, variant, route));
            if (samples?.length !== report.runs) throw new Error('ブラウザセルの試行数が不正です');
            const row = {
              round,
              case: condition,
              reverse,
              entry: route,
              variant,
              primary: distribution(samples.map((x) => x.primary)),
              secondary: distribution(samples.map((x) => x.secondary)),
              load: distribution(samples.map((x) => x.load)),
              ready: distribution(samples.map((x) => x.ready)),
              shell: distribution(samples.map((x) => x.shell)),
            };
            browserRows.push(row);
            stats.set(variant, row.ready);
            completionLines.push(
              `| ${round} | ${names[condition]} | ${order} | ${entryNames[route]} | ${variant} | ${formatted(row.primary)} | ${formatted(row.secondary)} | ${formatted(row.load)} | ${formatted(row.shell)} |`,
            );
          }
          const b = stats.get('B')!,
            c = stats.get('C')!;
          if (b.p95 <= 0) throw new Error('比較元の操作開始時点は0より大きい値が必要です');
          const saving = b.p95 - c.p95;
          const pct = (100 * saving) / b.p95;
          comparisons.push({
            round,
            case: condition,
            reverse,
            entry: route,
            B_p95: b.p95,
            C_p95: c.p95,
            saving_ms: saving,
            saving_pct: pct,
            pass: saving >= 100 && saving * 100 >= b.p95 * 10,
            bad: -saving >= 100 && -saving * 100 >= b.p95 * 10,
          });
          readyLines.push(
            `| ${round} | ${names[condition]} | ${order} | ${entryNames[route]} | ${formatted(b)} | ${formatted(c)} | ${saving.toFixed(2)} (${pct.toFixed(1)}%) |`,
          );
        }
      }
  const qualifyingPaths = [];
  for (const condition of generalCases)
    for (const route of entries) {
      if (comparisons.filter((x) => x.case === condition && x.entry === route && !x.reverse && x.pass).length >= 2)
        qualifyingPaths.push({ case: condition, entry: route });
    }
  const worsening = comparisons.filter((x) => x.bad);
  return {
    eligible: qualifyingPaths.length > 0 && worsening.length === 0,
    qualifyingPaths,
    worsening,
    comparisons,
    apiRows,
    browserRows,
    markdown: [...apiLines, ...readyLines, ...completionLines].join('\n') + '\n',
  };
}

if (import.meta.main) {
  const [input, prefix] = process.argv.slice(2);
  if (!input || !prefix || process.argv.length !== 4)
    throw new Error('使い方: node scripts/today-loading-summary.ts <結果.json[.gz]> <出力の接頭辞>');
  const bytes = readFileSync(input);
  const { markdown, ...result } = summarizeToday(
    JSON.parse((input.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')),
  );
  writeFileSync(`${prefix}.json`, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(`${prefix}.md`, markdown);
  console.log(`採用基準: ${result.eligible ? '達成' : '未達'}。出力: ${prefix}.json / ${prefix}.md`);
}
