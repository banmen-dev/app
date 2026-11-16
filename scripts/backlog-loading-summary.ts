// node scripts/backlog-loading-summary.ts <結果.json[.gz]> <出力の接頭辞>
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { percentile } from './loading-stats.ts';
import { backlogCases } from './backlog-loading-fixture.ts';

export const backlogEntries = ['direct', 'navigation', 'invalidate', 'filter'] as const;
const ms = z.number().finite().nonnegative();
const common = {
  round: z.number().int().min(1),
  case: z
    .number()
    .int()
    .min(0)
    .max(backlogCases.length - 1),
  reverse: z.boolean(),
  trial: z.number().int().nonnegative(),
  primary: ms,
  load: ms,
};
const reportSchema = z.object({
  runs: z.number().int().min(20),
  rounds: z.number().int().min(2),
  completedAt: z.iso.datetime(),
  error: z.undefined().optional(),
  api: z.array(
    z.object({
      ...common,
      variant: z.enum(['A', 'B', 'C']),
      definitions: ms.nullable(),
      experience: ms.nullable(),
      total: ms,
    }),
  ),
  browser: z.array(
    z.object({
      ...common,
      variant: z.enum(['B', 'C']),
      entry: z.enum(backlogEntries),
      definitions: ms,
      experience: ms,
      ready: ms.positive(),
      choices: ms.positive(),
      shell: ms,
      hasTask: z.boolean(),
    }),
  ),
});
export type BacklogReport = z.input<typeof reportSchema>;
type Distribution = { p50: number; p95: number };
const distribution = (values: number[]): Distribution => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
});
const formatted = (value: Distribution | null) =>
  value === null ? '—' : `${value.p50.toFixed(2)} / ${value.p95.toFixed(2)}`;
const entryNames = { direct: '直接表示', navigation: '画面内遷移', invalidate: '再読み取り', filter: '絞り込み変更' };
const key = (round: number, condition: number, reverse: boolean, variant: string, entry = '') =>
  JSON.stringify([round, condition, reverse, variant, entry]);

// 温め試行を除いた全セルと、セル内の通し番号を確かめてから採否を計算する。
// API A や空の面の表示だけの差は、タスクの操作開始の改善に数えない。
export function summarizeBacklog(value: unknown) {
  const report = reportSchema.parse(value);
  const cells = report.rounds * backlogCases.length * 2;
  if (
    report.api.length !== cells * 3 * report.runs ||
    report.browser.length !== cells * 2 * backlogEntries.length * report.runs
  )
    throw new Error('試行数が不足または過剰です');
  const apiGroups = new Map<string, typeof report.api>();
  const browserGroups = new Map<string, typeof report.browser>();
  function add<T extends { round: number; trial: number }>(groups: Map<string, T[]>, id: string, sample: T) {
    if (sample.round > report.rounds || sample.trial >= report.runs) throw new Error('巡または試行番号が範囲外です');
    const group = groups.get(id) ?? [];
    if (group.some((x) => x.trial === sample.trial)) throw new Error('同じセルの試行番号が重複しています');
    group.push(sample);
    groups.set(id, group);
  }
  for (const x of report.api) {
    if (
      (x.variant === 'A') !== (x.definitions === null && x.experience === null) ||
      (x.variant !== 'A' && (x.definitions === null || x.experience === null))
    )
      throw new Error('APIの方式と従の計測値が一致しません');
    if (x.primary > x.load || x.load > x.total || (x.definitions ?? 0) > x.total || (x.experience ?? 0) > x.total)
      throw new Error('APIの完了時点の順序が不正です');
    if (x.variant === 'B' && Math.max(x.primary, x.definitions!, x.experience!) > x.load)
      throw new Error('API Bはすべての応答を待ってからloadを返します');
    add(apiGroups, key(x.round, x.case, x.reverse, x.variant), x);
  }
  for (const x of report.browser) {
    if (x.hasTask !== backlogCases[x.case]!.hasTask) throw new Error('タスクの条件が不正です');
    if (x.primary > x.load || x.load > x.ready || x.definitions > x.choices)
      throw new Error('ブラウザの完了時点の順序が不正です');
    if (x.variant === 'B' && Math.max(x.primary, x.definitions, x.experience) > x.load)
      throw new Error('ブラウザ Bはすべての応答を待ってからloadを返します');
    add(browserGroups, key(x.round, x.case, x.reverse, x.variant, x.entry), x);
  }
  const apiRows = [];
  const browserRows = [];
  const comparisons = [];
  const apiLines = [
    '\n## API（ms、p50 / p95）\n',
    '| 巡 | 条件 | 発行順 | 方式 | 主完了 | 区分・リポジトリ完了 | 経験値完了 | load相当 | 全応答 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  const readyLines = [
    '\n## ブラウザの操作開始／空の木の表示（ms、p50 / p95）\n',
    '空のワークスペースと検索該当なしは表示指標で、タスク操作開始の採用根拠にしない。差は B の p95 − C の p95。負は C の方が遅い。分位点同士の比較で、同一試行内の短縮ではない。\n',
    '| 巡 | 条件 | 発行順 | 経路 | 指標 | B | C | p95差 |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: |',
  ];
  const completionLines = [
    '\n## ブラウザの完了時点（ms、p50 / p95）\n',
    '本当に空の作業場（case 3）では絞り込みの帯を表示しないため、「選択肢利用可能」は一覧応答が画面の状態へ反映された確認時点であり、選択欄の操作可能時点ではない。\n',
    '| 巡 | 条件 | 発行順 | 経路 | 方式 | 主完了 | 区分・リポジトリ完了 | 経験値完了 | load復帰 | 選択肢利用可能 | 枠のAPI完了 |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (let round = 1; round <= report.rounds; round++)
    for (let condition = 0; condition < backlogCases.length; condition++)
      for (const reverse of [false, true]) {
        const name = backlogCases[condition]!.name;
        const hasTask = backlogCases[condition]!.hasTask;
        const order = reverse ? '逆' : '正';
        for (const variant of ['A', 'B', 'C'] as const) {
          const samples = apiGroups.get(key(round, condition, reverse, variant));
          if (samples?.length !== report.runs) throw new Error('APIセルの試行数が不正です');
          const row = {
            round,
            case: condition,
            reverse,
            variant,
            primary: distribution(samples.map((x) => x.primary)),
            definitions: variant === 'A' ? null : distribution(samples.map((x) => x.definitions!)),
            experience: variant === 'A' ? null : distribution(samples.map((x) => x.experience!)),
            load: distribution(samples.map((x) => x.load)),
            total: distribution(samples.map((x) => x.total)),
          };
          apiRows.push(row);
          apiLines.push(
            `| ${round} | ${name} | ${order} | ${variant} | ${formatted(row.primary)} | ${formatted(row.definitions)} | ${formatted(row.experience)} | ${formatted(row.load)} | ${formatted(row.total)} |`,
          );
        }
        for (const entry of backlogEntries) {
          const stats = new Map<string, Distribution>();
          for (const variant of ['B', 'C'] as const) {
            const samples = browserGroups.get(key(round, condition, reverse, variant, entry));
            if (samples?.length !== report.runs) throw new Error('ブラウザセルの試行数が不正です');
            const row = {
              round,
              case: condition,
              reverse,
              variant,
              entry,
              hasTask,
              primary: distribution(samples.map((x) => x.primary)),
              definitions: distribution(samples.map((x) => x.definitions)),
              experience: distribution(samples.map((x) => x.experience)),
              load: distribution(samples.map((x) => x.load)),
              ready: distribution(samples.map((x) => x.ready)),
              choices: distribution(samples.map((x) => x.choices)),
              shell: distribution(samples.map((x) => x.shell)),
            };
            browserRows.push(row);
            stats.set(variant, row.ready);
            completionLines.push(
              `| ${round} | ${name} | ${order} | ${entryNames[entry]} | ${variant} | ${formatted(row.primary)} | ${formatted(row.definitions)} | ${formatted(row.experience)} | ${formatted(row.load)} | ${formatted(row.choices)} | ${formatted(row.shell)} |`,
            );
          }
          const b = stats.get('B')!,
            c = stats.get('C')!;
          const saving = b.p95 - c.p95;
          const pct = (saving * 100) / b.p95;
          comparisons.push({
            round,
            case: condition,
            reverse,
            entry,
            hasTask,
            B_p95: b.p95,
            C_p95: c.p95,
            saving_ms: saving,
            saving_pct: pct,
            pass: hasTask && saving >= 100 && saving * 100 >= b.p95 * 10,
            bad: -saving >= 100 && -saving * 100 >= b.p95 * 10,
          });
          readyLines.push(
            `| ${round} | ${name} | ${order} | ${entryNames[entry]} | ${hasTask ? '操作開始' : '空の表示'} | ${formatted(b)} | ${formatted(c)} | ${saving.toFixed(2)} (${pct.toFixed(1)}%) |`,
          );
        }
      }
  const qualifyingPaths = [];
  // 合意した独立2巡以上での再現を判定する。悪化は下で全巡・全条件を調べる。
  for (let condition = 0; condition < backlogCases.length; condition++)
    for (const entry of backlogEntries)
      if (comparisons.filter((x) => x.case === condition && x.entry === entry && !x.reverse && x.pass).length >= 2)
        qualifyingPaths.push({ case: condition, entry });
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
    throw new Error('使い方: node scripts/backlog-loading-summary.ts <結果.json[.gz]> <出力の接頭辞>');
  const bytes = readFileSync(input);
  const { markdown, ...result } = summarizeBacklog(
    JSON.parse((input.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')),
  );
  writeFileSync(`${prefix}.json`, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(`${prefix}.md`, markdown);
  console.log(`採用基準: ${result.eligible ? '達成' : '未達'}。出力: ${prefix}.json / ${prefix}.md`);
}
