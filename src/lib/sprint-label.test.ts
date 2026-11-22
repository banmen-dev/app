import { expect, test } from 'vitest';
import { word } from '../shared/vocabulary.ts';
import { sprintLabel, sprintLabelWithPeriod, completedMessage } from './sprint-label.ts';
test('完了の知らせは1行で、始まっていないスプリントから外れたら添える', () => {
  expect(completedMessage(false, word)).toBe('タスクを完了にしました');
  expect(completedMessage(true, word)).toBe('タスクを完了にしました。始まっていないスプリントから外れました');
});

for (const [name, label, withPeriod] of [
  ['スプリント 12', 'スプリント 12', 'スプリント 12（1/4〜1/17）'],
  ['新年の仕上げ', '新年の仕上げ', '新年の仕上げ（1/4〜1/17）'],
  [null, '1/4〜1/17', '1/4〜1/17'],
] as const) {
  test(`スプリントの名前をそのまま出す: ${name}`, () => {
    const sprint = { name, start_on: '2099-01-04', end_on: '2099-01-17' };
    expect(sprintLabel(sprint, word)).toBe(label);
    expect(sprintLabelWithPeriod(sprint, word)).toBe(withPeriod);
  });
}
