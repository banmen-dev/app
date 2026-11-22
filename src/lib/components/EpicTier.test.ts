// 段階の印の文字。額を渡したときだけ「・額 XP」を添え、区切りの空白を詰めない（ダイアログのラジオの読み上げの名前になる）
import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import EpicTier from './EpicTier.svelte';

const textOf = (html: string) => html.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, '');

test('額を渡さなければ段階の呼び名だけを出す', () => {
  expect(textOf(render(EpicTier, { props: { tier: 'medium' } }).body)).toBe('中');
});

test('額を渡すと「呼び名 · 額 XP」と空白を保って出す', () => {
  expect(textOf(render(EpicTier, { props: { tier: 'small', xp: 100 } }).body)).toBe('小 · 100 XP');
});
