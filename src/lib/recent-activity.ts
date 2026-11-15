// 組織のホームの「最近の更新」の1件ごとの見せ方（recent-activity の結果を、辞書の言葉の文と日付ごとの区分にする）。
// 辞書は引数（translate）で受け取り、画面の状態に頼らない（テストが画面なしで呼べる）
import type { RecentActivityEntry } from '../shared/operations/organization/recent-activity.ts';
import type { DictionaryKey, TemplateParams } from '../shared/vocabulary.ts';
import { historyFieldLabel } from './task-history.ts';
import { formatTodayLabel } from './format-datetime.ts';

export type Translate = (key: DictionaryKey, params?: TemplateParams) => string;

// 変えた欄の名前を辞書の言葉にする。ストーリーの受け入れ基準のほかは、タスクの履歴と同じ表（historyFieldLabel）。
// 同じ言葉（知らない欄の「そのほかの欄」など）は1つにまとめ、保存した順を保つ
export function fieldLabels(fields: readonly string[], t: Translate): string[] {
  const labels = fields.map((field) => (field === 'acceptance_criteria_md' ? t('ac') : historyFieldLabel(field, t)));
  return [...new Set(labels)];
}

// 1件の文。した人が分からない行（定期処理か運用者）は辞書の言葉で出す
export function activitySentence(entry: RecentActivityEntry, t: Translate): string {
  const actor = entry.actor?.name ?? t('historyActorSystem');
  const done = t('done');
  switch (entry.event.kind) {
    case 'create':
      return t('activityCreated', { actor });
    case 'update': {
      const fields = fieldLabels(entry.event.fields, t);
      return fields.length === 0
        ? t('activityChanged', { actor })
        : t('activityUpdated', { actor, fields: fields.join('、') });
    }
    case 'complete':
      return t('activityCompleted', { actor, done });
    case 'reopen':
      return t('activityReopened', { actor, done });
    case 'comment':
      return t('activityCommented', { actor });
    case 'other':
      return t('activityChanged', { actor });
  }
}

// 行を押して開く詳細。ワークスペースのバックログに、対象の問い合わせ（task、story、epic_id）を付ける。
// 引き出しは、ワークスペースの枠（src/routes/[slug]/w/[id]/+layout.svelte）が問い合わせを見て置く
export function targetQuery(target: RecentActivityEntry['target']): string {
  const key = target.kind === 'task' ? 'task' : target.kind === 'story' ? 'story' : 'epic_id';
  return `?${key}=${encodeURIComponent(target.id)}`;
}

// 時刻（HH:mm。ブラウザのタイムゾーン）。読めない値は元のまま返す
export function formatActivityTime(iso: string, timeZone?: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(time);
}

export type ActivityDay = { label: string; entries: RecentActivityEntry[] };

// 日付（ブラウザのタイムゾーン）ごとの区分。並びは入力のまま（新しい順）で、同じ日が続く間を1つにまとめる。
// 読めない日時の行は、前の区分に続ける（先頭なら日付を日時の文字のまま）
export function groupByDay(entries: readonly RecentActivityEntry[], timeZone?: string): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const entry of entries) {
    const time = Date.parse(entry.created_at);
    const label = Number.isNaN(time)
      ? (days.at(-1)?.label ?? entry.created_at)
      : formatTodayLabel(new Date(time), timeZone);
    const last = days.at(-1);
    if (last !== undefined && last.label === label) last.entries.push(entry);
    else days.push({ label, entries: [entry] });
  }
  return days;
}

// 続きを足す。ID が重なる行（読んでいる間に先頭へ足された行がずれて、境目で重なる）は足さない
export function appendEntries(
  current: readonly RecentActivityEntry[],
  more: readonly RecentActivityEntry[],
): RecentActivityEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...more.filter((entry) => !seen.has(entry.id))];
}
