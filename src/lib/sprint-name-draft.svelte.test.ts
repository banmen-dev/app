import { describe, expect, test } from 'vitest';
import { SprintNameDraft } from './sprint-name-draft.svelte.ts';

describe('作るダイアログの名前の初期値', () => {
  test('連番と開始日を展開し、入力前だけ開始日の変更に合わせる', () => {
    const draft = new SprintNameDraft('スプリント{yyyy}-{mm}-{w}w', 12);
    expect(draft.value('2026-01-05')).toBe('スプリント2026-01-1w');
    expect(draft.value('2026-01-12')).toBe('スプリント2026-01-2w');
    draft.manual = '手で決めた名前';
    expect(draft.value('2026-01-19')).toBe('手で決めた名前');
    draft.manual = '';
    expect(draft.value('2026-01-26')).toBe('');
  });
  test('ルール無しは空、開き直すと新しい番号から始まる', () => {
    expect(new SprintNameDraft(null, 1).value('2026-01-05')).toBe('');
    expect(new SprintNameDraft('スプリント{n}', 12).value('2026-01-05')).toBe('スプリント12');
    expect(new SprintNameDraft('スプリント{n}', 13).value('2026-01-05')).toBe('スプリント13');
  });
  test('展開後100字超は初期値を入れずエラー、人が名前を入れたら解消する', () => {
    const draft = new SprintNameDraft('あ'.repeat(97) + '{n}', 1000);
    expect(draft.value('2026-01-05')).toBe('');
    expect(draft.failed('2026-01-05')).toBe(true);
    draft.manual = '短い名前';
    expect(draft.failed('2026-01-05')).toBe(false);
    expect(new SprintNameDraft(null, 1).failed('2026-01-05')).toBe(false);
  });
});
