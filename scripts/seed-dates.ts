// seed（seed/data.sql）の、今日と比べて意味が変わる日付を、流した日時から作る。
// e2e も同じ関数で期待値を組むので、node の外のもの（wrangler、DB）に頼らない純関数にする
import { todayIn } from '../src/shared/clock.ts';
import { addDays, weekEndOf } from '../src/shared/due.ts';

// seed のワークスペースはどれも Asia/Tokyo
export const SEED_TIMEZONE = 'Asia/Tokyo';
const MONDAY = 1;

// 基準の日。week（W）は流した日の週の月曜、today（T）は流した日。どちらも Asia/Tokyo の日付（YYYY-MM-DD）
export type SeedBase = { now: Date; week: string; today: string };

export function seedBase(now: Date): SeedBase {
  const today = todayIn(SEED_TIMEZONE, now);
  return { now, today, week: addDays(weekEndOf(today, MONDAY), -6) };
}

// スプリントと休日は W に結ぶ（7 日単位で動くので、曜日と月曜始まりの週が変わらない）
export function seedWeekDate(base: SeedBase, days: number): string {
  return addDays(base.week, days);
}

// 期日は T に結ぶ（期日切れと今週は今日との差で決まる）
export function seedDueDate(base: SeedBase, days: number): string {
  return addDays(base.today, days);
}

// 日付と UTC の時刻（HH:MM）の日時。流した日時より後になるなら流した日時にする
// （月曜から火曜の朝に流すと、進行中のスプリントを始めた日時や持ち越した日時が未来になるため）
function seedDateTime(base: SeedBase, date: string, time: string): string {
  const at = new Date(`${date}T${time}:00.000Z`);
  return (at.getTime() > base.now.getTime() ? base.now : at).toISOString();
}

// 印は {{W+14}}、{{T-3}}（日付）と {{W+1 00:30}}（日時）。引用符の外に置き、埋めた値を引用符で囲んで返す。
// 埋めずに流すと SQL の構文エラーで落ちる
const MARKER = /\{\{([WT])([+-]\d+)(?: (\d{2}:\d{2}))?\}\}/g;

export function fillSeedDates(data: string, now: Date): string {
  const base = seedBase(now);
  const filled = data.replace(MARKER, (_, anchor: string, offset: string, time: string | undefined) => {
    const date = anchor === 'W' ? seedWeekDate(base, Number(offset)) : seedDueDate(base, Number(offset));
    return `'${time === undefined ? date : seedDateTime(base, date, time)}'`;
  });
  const unknown = /\{\{[^}]*\}\}/.exec(filled);
  if (unknown !== null) throw new Error(`seed の日付の印を読めない: ${unknown[0]}`);
  return filled;
}
