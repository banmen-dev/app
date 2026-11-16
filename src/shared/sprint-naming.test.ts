import { describe, expect, test } from 'vitest';
import {
  expandSprintName,
  normalizeSprintName,
  sprintNameTemplateProblem,
  sprintNameTemplateSchema,
} from './sprint.ts';

describe('スプリントの命名ルール', () => {
  test('番号、日付の全変数と繰り返した変数を開始日から展開する', () => {
    expect(expandSprintName('{n}:{yyyy}/{yy}/{mm}/{m}/{dd}/{d}/{w}:{n}', '2026-01-05', 12)).toBe(
      '12:2026/26/01/1/05/5/1:12',
    );
    expect(expandSprintName('{yyyy}-{mm}-{dd}', '0001-02-03', 1)).toBe('0001-02-03');
    expect(expandSprintName('{yyyy}-{mm}-{dd}', '2028-02-29', 1)).toBe('2028-02-29');
  });
  test.each([
    ['2026-01-05', 1],
    ['2026-01-12', 2],
    ['2026-01-19', 3],
    ['2026-01-29', 5],
    ['2026-01-07', 1],
    ['2026-01-08', 2],
  ])('月の中の同じ曜日の回数: %s', (date, week) => {
    expect(expandSprintName('スプリント{yyyy}-{mm}-{w}w', date, 1)).toBe(`スプリント2026-01-${week}w`);
  });
  test.each(['{unknown}', '{}', '{N}', '{yyyy-mm}', 'prefix {n} {foo}'])('知らない変数を断る: %s', (value) => {
    expect(sprintNameTemplateProblem(value)).toBe('unknown_variable');
    expect(sprintNameTemplateSchema.safeParse(value).success).toBe(false);
  });
  test('名前と同じ100字の境界と断る文字、空の整え方を使う', () => {
    expect(sprintNameTemplateSchema.parse('  スプリント{n}  ')).toBe('スプリント{n}');
    expect(sprintNameTemplateSchema.parse('  ')).toBeNull();
    expect(sprintNameTemplateSchema.parse(null)).toBeNull();
    expect(sprintNameTemplateProblem('😀'.repeat(100))).toBeNull();
    expect(sprintNameTemplateProblem('😀'.repeat(101))).toBe('too_long');
    for (const value of ['a\n{n}', 'a\u0000{n}', 'a\u200b{n}']) {
      expect(sprintNameTemplateProblem(normalizeSprintName(value))).toBe('invalid_character');
    }
  });
  test('ルール無し、展開後の超過、暦でない日付と不正な番号では初期値を入れない', () => {
    expect(expandSprintName(null, '2026-01-05', 1)).toBeNull();
    expect(expandSprintName('a'.repeat(97) + '{n}', '2026-01-05', 1000)).toBeNull();
    expect(expandSprintName('a'.repeat(97) + '{n}', '2026-01-05', 123)).toHaveLength(100);
    expect(expandSprintName('{n}', '2026-02-29', 1)).toBeNull();
    expect(expandSprintName('{n}', '2026-01-05', 0)).toBeNull();
    expect(expandSprintName('{n}', '2026-01-05', 1.1)).toBeNull();
    expect(expandSprintName('{unknown}', '2026-01-05', 1)).toBeNull();
  });
});
