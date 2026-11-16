import { describe, expect, test } from 'vitest';
import type { RecentActivityEntry } from '../shared/operations/organization/recent-activity.ts';
import { word } from '../shared/vocabulary.ts';
import {
  activitySentence,
  appendEntries,
  fieldLabels,
  formatActivityTime,
  groupByDay,
  targetQuery,
} from './recent-activity.ts';
import type { Translate } from './task-history.ts';

const t: Translate = (key, params) => word(key, params);

function entry(overrides: Partial<RecentActivityEntry> = {}): RecentActivityEntry {
  return {
    id: 'a1',
    created_at: '2026-10-20T05:00:00.000Z',
    actor: { id: 'u1', name: '若葉 湊' },
    workspace: { id: 'w1', name: '青葉チーム' },
    target: { kind: 'task', id: 't1', title: '見積もりを送る' },
    event: { kind: 'create' },
    ...overrides,
  };
}

describe('activitySentence', () => {
  test('内容の種類ごとに、した人を入れた文にする', () => {
    expect(activitySentence(entry(), t)).toBe('若葉 湊が作成した');
    expect(activitySentence(entry({ event: { kind: 'complete' } }), t)).toBe('若葉 湊が完了にした');
    expect(activitySentence(entry({ event: { kind: 'reopen' } }), t)).toBe('若葉 湊が完了を戻した');
    expect(activitySentence(entry({ event: { kind: 'comment', body: 'はい', truncated: false } }), t)).toBe(
      '若葉 湊がコメントした',
    );
    expect(activitySentence(entry({ event: { kind: 'other' } }), t)).toBe('若葉 湊が変更した');
  });

  test('変えた欄の名前を辞書の言葉にし、同じ言葉は1つにまとめる。欄が無ければ欄を出さない', () => {
    const fields = ['title', 'due_on', 'mystery', 'field', 'acceptance_criteria_md'];
    expect(activitySentence(entry({ event: { kind: 'update', fields } }), t)).toBe(
      '若葉 湊がタイトル、期日、そのほかの欄、受け入れ基準を変更した',
    );
    expect(activitySentence(entry({ event: { kind: 'update', fields: [] } }), t)).toBe('若葉 湊が変更した');
    expect(fieldLabels(['__proto__', 'constructor'], t)).toEqual(['そのほかの欄']);
  });

  test('した人が分からない行は、定期処理か運用者として出す', () => {
    expect(activitySentence(entry({ actor: null }), t)).toBe('定期処理か運用者が作成した');
  });
});

describe('targetQuery', () => {
  test('タスクは task、ストーリーは story、エピックは epic_id で、ID を符号化する', () => {
    expect(targetQuery({ kind: 'task', id: 'a b', title: '' })).toBe('?task=a%20b');
    expect(targetQuery({ kind: 'story', id: 's1', title: '' })).toBe('?story=s1');
    expect(targetQuery({ kind: 'epic', id: 'e1', title: '' })).toBe('?epic_id=e1');
  });
});

describe('groupByDay と formatActivityTime', () => {
  test('日付（指定のタイムゾーン）が同じ間を1つの区分にまとめ、新しい順を保つ', () => {
    const entries = [
      entry({ id: 'a', created_at: '2026-10-20T16:00:00.000Z' }),
      entry({ id: 'b', created_at: '2026-10-20T14:59:00.000Z' }),
      entry({ id: 'c', created_at: '2026-10-19T14:59:00.000Z' }),
    ];
    const days = groupByDay(entries, 'Asia/Tokyo');
    expect(days.map((day) => [day.label, day.entries.map((e) => e.id)])).toEqual([
      ['2026年10月21日（水）', ['a']],
      ['2026年10月20日（火）', ['b']],
      ['2026年10月19日（月）', ['c']],
    ]);
    // 同じ instant でも、タイムゾーンが違えば区分が変わる
    expect(groupByDay(entries, 'UTC').map((day) => day.entries.map((e) => e.id))).toEqual([['a', 'b'], ['c']]);
  });

  test('時刻は HH:mm で、0 時は 24 時にしない。読めない日時は元のまま', () => {
    expect(formatActivityTime('2026-10-20T15:05:00.000Z', 'Asia/Tokyo')).toBe('00:05');
    expect(formatActivityTime('2026-10-20T05:07:00.000Z', 'Asia/Tokyo')).toBe('14:07');
    expect(formatActivityTime('あした')).toBe('あした');
  });

  test('日時を読めない行は前の区分に続け、先頭なら日時の文字を見出しにする', () => {
    const days = groupByDay([entry({ id: 'x', created_at: 'あした' }), entry({ id: 'y', created_at: 'あした' })]);
    expect(days).toHaveLength(1);
    expect(days[0]!.label).toBe('あした');
    expect(days[0]!.entries.map((e) => e.id)).toEqual(['x', 'y']);
  });
});

describe('appendEntries', () => {
  test('続きを足し、ID が重なる行は足さない', () => {
    const a = entry({ id: 'a' });
    const b = entry({ id: 'b' });
    const c = entry({ id: 'c' });
    expect(appendEntries([a, b], [b, c]).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(appendEntries([], [a]).map((e) => e.id)).toEqual(['a']);
  });
});
