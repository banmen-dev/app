import { expect, test } from 'vitest';
import { SprintNumberDraft } from './sprint-number-draft.svelte.ts';

test('ルールの書きかけ中に基準が12から13へ進んでも、番号を編集した扱いにしない', () => {
  const draft = new SprintNumberDraft(12);
  expect(draft.receive(13)).toBe(true);
  expect(draft.value).toBe(13);
  expect(draft.edited).toBe(false);
  expect(draft.receive(14)).toBe(true);
  expect(draft.edited).toBe(false);
});
test('人が入れた番号は基準の読み直しで上書きせず、保存後は次の番号に追従する', () => {
  const draft = new SprintNumberDraft(12);
  draft.input();
  draft.value = 1;
  expect(draft.receive(13)).toBe(false);
  expect(draft.value).toBe(1);
  expect(draft.edited).toBe(true);
  draft.saved(1);
  expect(draft.edited).toBe(false);
  expect(draft.receive(2)).toBe(true);
  expect(draft.value).toBe(2);
});
test('一度入力した事実は、元と同じ番号でも基準更新と混同しない', () => {
  const draft = new SprintNumberDraft(12);
  draft.input();
  draft.value = 12;
  expect(draft.receive(13)).toBe(false);
  expect(draft.edited).toBe(true);
  expect(draft.value).toBe(12);
});
