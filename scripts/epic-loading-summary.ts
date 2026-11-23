import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { percentile } from './loading-stats.ts';

// 計測した方式と経路。ブラウザの計測器は C を製品に入れたときに外した（#1058）。計測時のソースは docs/epic-loading-*source.json.gz にある
export const epicVariants = ['A', 'B', 'C'] as const;
export const epicEntries = ['direct', 'navigation', 'reload'] as const;

const ms = z.number().finite().nonnegative();
const sample = z.object({
  round: z.int().min(1),
  trial: z.int().nonnegative(),
  variant: z.enum(epicVariants),
  entry: z.enum(epicEntries),
  display: ms,
  ready: ms,
  choices: ms,
  afterEditClick: ms,
  primary: ms,
  definitions: ms.nullable(),
  drawerEpic: ms,
  drawerDefinitions: ms,
  shell: ms.nullable(),
});
export type EpicSample = z.infer<typeof sample>;
const input = z.object({
  runs: z.int().min(1).max(1000),
  rounds: z.int().min(1).max(10),
  completedAt: z.iso.datetime(),
  refreshVerified: z.literal(true),
  error: z.undefined().optional(),
  samples: z.array(sample),
});
export const timingFields = [
  'display',
  'ready',
  'choices',
  'afterEditClick',
  'primary',
  'definitions',
  'drawerEpic',
  'drawerDefinitions',
  'shell',
] as const;
const guardedFields = ['display', 'ready', 'choices'] as const;
type Effect = {
  round: number;
  entry: EpicSample['entry'];
  field: (typeof guardedFields)[number];
  baseline: number;
  candidate: number;
  delta: number;
};

function quantiles(values: number[]) {
  return values.length ? { p50: percentile(values, 0.5), p95: percentile(values, 0.95), count: values.length } : null;
}

function key(round: number, variant: EpicSample['variant'], entry: EpicSample['entry']) {
  return `${round}/${variant}/${entry}`;
}

function enough(delta: number, baseline: number) {
  return delta >= 100 && delta >= baseline * 0.1;
}

export function summarizeEpic(value: unknown) {
  const { runs, rounds, samples } = input.parse(value);
  const groups = new Map<string, Map<number, EpicSample>>();
  for (const row of samples) {
    const {
      round,
      trial,
      variant,
      entry,
      display,
      ready,
      choices,
      primary,
      definitions,
      drawerEpic,
      drawerDefinitions,
      afterEditClick,
    } = row;
    const cell = key(round, variant, entry);
    const trials = groups.get(cell) ?? new Map<number, EpicSample>();
    if (round > rounds || trial >= runs || trials.has(trial))
      throw new Error(`${cell}: 範囲外または重複した試行 ${trial}`);
    if (
      (variant === 'C') !== (definitions === null) ||
      (variant === 'A' && definitions! > display) ||
      primary > display ||
      display > ready ||
      ready > choices - afterEditClick ||
      choices - afterEditClick > drawerEpic ||
      drawerEpic > drawerDefinitions ||
      drawerDefinitions > choices
    ) {
      throw new Error(`${cell}: 方式または時系列に反する試行 ${trial}`);
    }
    trials.set(trial, row);
    groups.set(cell, trials);
  }

  const cells = [];
  const improvements: Effect[] = [];
  const regressions: Effect[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (const entry of epicEntries) {
      const readings = epicVariants.map((variant) => {
        const trials = groups.get(key(round, variant, entry));
        if (trials?.size !== runs) throw new Error(`${key(round, variant, entry)}: 試行が不足しています`);
        const timings = Object.fromEntries(
          timingFields.map((field) => [
            field,
            quantiles([...trials.values()].map((row) => row[field]).filter((time) => time !== null)),
          ]),
        ) as Record<(typeof timingFields)[number], ReturnType<typeof quantiles>>;
        return { round, entry, variant, timings };
      });
      cells.push(...readings);
      const [a, , c] = readings;
      for (const field of guardedFields) {
        const baseline = a!.timings[field]!.p95;
        const candidate = c!.timings[field]!.p95;
        const delta = candidate - baseline;
        const effect = { round, entry, field, baseline, candidate, delta };
        if (field === 'ready' && enough(-delta, baseline)) improvements.push(effect);
        if (enough(delta, baseline)) regressions.push(effect);
      }
    }
  }

  const reproduced = epicEntries.filter(
    (entry) => improvements.filter((effect) => effect.entry === entry).length === rounds,
  );
  // 予行の少数試行から採否を出さない。独立した追加巡もすべて判定に含める。
  const formal = rounds >= 2 && runs === 20;
  const decision = !formal ? 'preview' : reproduced.length && !regressions.length ? 'implement' : 'hold';
  return { runs, rounds, decision, reproduced, improvements, regressions, cells };
}

if (import.meta.main) {
  const [, , source, destination] = process.argv;
  if (!source) throw new Error('生データのパスが必要です');
  const stored = readFileSync(source);
  const raw = source.endsWith('.gz') ? gunzipSync(stored) : stored;
  const result = JSON.stringify(summarizeEpic(JSON.parse(raw.toString('utf8'))), null, 2) + '\n';
  if (destination) writeFileSync(destination, result);
  else process.stdout.write(result);
}
