// スプリントの名前をそのまま出す。名前が無ければ期間。画面と行の印で同じ決まりを使う。
import type { DictionaryKey, TemplateParams } from '../shared/vocabulary.ts';
import { formatMonthDay } from './format.ts';

type Translate = (key: DictionaryKey, params?: TemplateParams) => string;

type SprintNaming = { name: string | null; start_on: string; end_on: string };

export function sprintLabel(sprint: SprintNaming, t: Translate): string {
  return sprint.name ?? sprintPeriod(sprint, t);
}

// 期間（M/D〜M/D）
export function sprintPeriod(sprint: SprintNaming, t: Translate): string {
  return t('sprintPeriod', { start: formatMonthDay(sprint.start_on), end: formatMonthDay(sprint.end_on) });
}

// 呼び名に期間を添える。名前のあるスプリントは「<名前>（<M/D>〜<M/D>）」、名前の無いスプリントは期間が名前なので重ねない
export function sprintLabelWithPeriod(sprint: SprintNaming, t: Translate): string {
  const label = sprintLabel(sprint, t);
  return sprint.name === null ? label : t('sprintLabelWithPeriod', { label, period: sprintPeriod(sprint, t) });
}

// タスクを完了にしたときの知らせ。始まっていないスプリントの中で完了してスプリントから外れたら（task-complete の left_sprint）、
// 「始まっていない<スプリント>から外れました」を添える
export function completedMessage(leftSprint: boolean, xpGranted: number, t: Translate): string {
  const done = t('taskCompleted', { task: t('task'), done: t('done') });
  const message = leftSprint ? `${done}。${t('taskLeftPlannedSprint', { sprint: t('sprint') })}` : done;
  return xpGranted > 0 ? `${message}\n${t('taskCompletedXp', { amount: xpGranted, unit: t('xpUnit') })}` : message;
}
