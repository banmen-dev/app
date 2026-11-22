import { parseArgs } from 'node:util';

export function screenReviewOptions(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { round: { type: 'string', default: '1' }, exclusions: { type: 'string' } },
  });
  const [screen, ...states] = positionals;
  if (screen !== 'today' || states.some((state) => state !== 'list') || states.length > 1)
    throw new Error('使い方: pnpm screen-review today [list] [--round <1–3>] [--exclusions <ファイル>]');
  if (!/^[123]$/.test(values.round)) throw new Error('--round は 1、2、3 のいずれかを指定してください');
  return { screen, state: 'list', round: values.round, exclusions: values.exclusions };
}

// 直近の水曜10時（日本時間）。平日の区分を揃えつつ、実時刻で認証する seed のセッションを期限内に保つ。
export function reviewCaptureTime(now: Date): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1));
  const sinceWednesday = (day.getUTCDay() + 4) % 7;
  day.setUTCDate(day.getUTCDate() - sinceWednesday);
  if (day.getTime() > now.getTime()) day.setUTCDate(day.getUTCDate() - 7);
  return day;
}
