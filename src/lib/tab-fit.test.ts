import { expect, test } from 'vitest';
import { fitTabCount } from './tab-fit.ts';

const widths = [60, 60, 60, 60];

test('全部が入るなら全部を残し、「その他」の分は空けない', () => {
  // 60*4 + 間隔 8*3 = 264
  expect(fitTabCount(widths, 264, 8, 80)).toBe(4);
  expect(fitTabCount(widths, 400, 8, 80)).toBe(4);
});

test('入らないときは「その他」のボタンの分を空けて、入るだけを前から残す', () => {
  // 263 では全部は入らない。ボタン 80 + (8+60)*n <= 263 → n = 2
  expect(fitTabCount(widths, 263, 8, 80)).toBe(2);
  // ちょうど 80 + 68*2 = 216
  expect(fitTabCount(widths, 216, 8, 80)).toBe(2);
  expect(fitTabCount(widths, 215, 8, 80)).toBe(1);
});

test('ボタンしか入らない幅では 0 を返す（全部を「その他」にまとめる）', () => {
  expect(fitTabCount(widths, 100, 8, 80)).toBe(0);
  expect(fitTabCount(widths, 40, 8, 80)).toBe(0);
});

test('タブの幅がそろっていなくても、前から詰めて入るところで止める', () => {
  expect(fitTabCount([100, 60, 60], 200, 8, 70)).toBe(1);
  expect(fitTabCount([20, 100, 60], 190, 8, 70)).toBe(1);
});

test('幅が測れていないときは全部を残す', () => {
  expect(fitTabCount(widths, 0, 8, 80)).toBe(4);
  expect(fitTabCount(widths, Number.NaN, 8, 80)).toBe(4);
  expect(fitTabCount([], 100, 8, 80)).toBe(0);
});
