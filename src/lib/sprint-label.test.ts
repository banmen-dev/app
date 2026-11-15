import { expect, test } from 'vitest';
import { word } from '../shared/vocabulary.ts';
import { sprintLabel, sprintLabelWithPeriod, completedMessage } from './sprint-label.ts';
test('完了の知らせは実際の経験値を次の1行に添え、0なら省く', () => {
  expect(completedMessage(false, 40, word)).toBe(`${completedMessage(false, 0, word)}\n+40 XP`);
  expect(completedMessage(false, 0, word)).not.toContain('XP');
  expect(completedMessage(true, 15, word)).toBe(`${completedMessage(true, 0, word)}\n+15 XP`);
  expect(completedMessage(true, 0, word)).toContain('から外れました');
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
