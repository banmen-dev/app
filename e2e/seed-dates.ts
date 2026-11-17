// seed の日付（seed/data.sql の印）の期待値を、seed と同じ関数（scripts/seed-dates.ts）と同じ日時から組む。
// 日時は e2e/global-setup.ts が1回だけ決めて、seed と環境変数に渡す
import { seedBase, seedDueDate, seedWeekDate, type SeedBase } from '../scripts/seed-dates.ts';
import { formatMonthDay } from '../src/lib/format.ts';

export const SEED_NOW_ENV = 'E2E_SEED_NOW';

let cached: SeedBase | undefined;

function base(): SeedBase {
  if (cached !== undefined) return cached;
  const raw = process.env[SEED_NOW_ENV];
  const now = new Date(raw ?? '');
  if (Number.isNaN(now.getTime())) {
    throw new Error(`${SEED_NOW_ENV} が無い。seed の日付は e2e/global-setup.ts が決めた日時から組む`);
  }
  cached = seedBase(now);
  return cached;
}

// 流した日の週の月曜（W）から days 日の日付（YYYY-MM-DD）
export function seedWeek(days: number): string {
  return seedWeekDate(base(), days);
}

// 流した日（T）から days 日の日付（YYYY-MM-DD）
export function seedDue(days: number): string {
  return seedDueDate(base(), days);
}

// 名前の無いスプリントの見出しの形（例 11/2〜11/15。src/lib/sprint-label.ts の sprintPeriod と同じ）
export function seedSprintLabel(startDays: number, endDays: number): string {
  return `${formatMonthDay(seedWeek(startDays))}〜${formatMonthDay(seedWeek(endDays))}`;
}

// 流した日（T）から days 日の期日の短い形（例 10/23）
export function seedDueMonthDay(days: number): string {
  return formatMonthDay(seedDue(days));
}

// 週の始まり（0〜6、0 が日曜）を、流した日の前日の曜日にする。応答の today を T に差し替えたテストで、
// 今週の終わりが T+5 になり、印を書いたとき（T が火曜、週の始まりが月曜）と同じ期日の関係になる
export function seedWeekStartBeforeToday(): number {
  return new Date(`${seedDue(-1)}T00:00:00Z`).getUTCDay();
}
