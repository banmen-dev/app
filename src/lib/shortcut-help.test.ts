import { describe, expect, test } from 'vitest';
import { shortcutHelpGroups } from './shortcut-help.ts';
import type { Shortcut } from './shortcuts.svelte.ts';

const shortcut = (id: string, extra: Partial<Extract<Shortcut, { helpOnly?: false }>> = {}): Shortcut => ({
  id,
  keys: 'c',
  label: () => id,
  run: () => {},
  ...extra,
});

describe('shortcutHelpGroups', () => {
  test('一覧専用項目も enabled と登録順に従って出し、ほかの画面で解除された項目は残さない', () => {
    let enabled = true;
    const entry: Shortcut = {
      id: 'card-order',
      keys: 'Alt + ↑ ↓',
      label: () => '列の中で動かす',
      helpOnly: true,
      enabled: () => enabled,
    };
    expect(shortcutHelpGroups([entry]).screen).toEqual([entry]);
    enabled = false;
    expect(shortcutHelpGroups([entry]).screen).toEqual([]);
    expect(shortcutHelpGroups([]).screen).toEqual([]);
  });

  test('global を付けたものを「どの画面でも」に、それ以外を「この画面」に、登録の順で分ける', () => {
    const groups = shortcutHelpGroups([
      shortcut('search', { global: true }),
      shortcut('new-task'),
      shortcut('go-sprint', { global: true }),
      shortcut('drawer-prev'),
    ]);
    expect(groups.screen.map((item) => item.id)).toEqual(['new-task', 'drawer-prev']);
    expect(groups.global.map((item) => item.id)).toEqual(['search', 'go-sprint']);
  });

  test('enabled が false のものは出さず、true と未指定は出す', () => {
    const groups = shortcutHelpGroups([
      shortcut('off', { enabled: () => false }),
      shortcut('on', { enabled: () => true }),
      shortcut('none'),
      shortcut('go-here', { global: true, enabled: () => false }),
    ]);
    expect(groups.screen.map((item) => item.id)).toEqual(['on', 'none']);
    expect(groups.global).toEqual([]);
  });

  test('組の中は helpOrder の小さい順で、同じ値は登録順', () => {
    const groups = shortcutHelpGroups([
      shortcut('help', { global: true, helpOrder: 9 }),
      shortcut('go-backlog', { global: true, helpOrder: 2 }),
      shortcut('go-sprint', { global: true, helpOrder: 2 }),
      shortcut('search', { global: true, helpOrder: 1 }),
    ]);
    expect(groups.global.map((item) => item.id)).toEqual(['search', 'go-backlog', 'go-sprint', 'help']);
  });

  test('この画面の組も helpOrder の小さい順で、順を付けないものは検索（1）より後ろの既定の位置に並ぶ', () => {
    const groups = shortcutHelpGroups([
      shortcut('b', { helpOrder: 2 }),
      shortcut('a', { helpOrder: 1 }),
      shortcut('unordered'),
    ]);
    expect(groups.screen.map((item) => item.id)).toEqual(['a', 'b', 'unordered']);
    // global を付けて helpOrder を付け忘れた登録は、検索（1）や画面を移るキー（2）より上に出ない
    const forgot = shortcutHelpGroups([
      shortcut('forgot', { global: true }),
      shortcut('search', { global: true, helpOrder: 1 }),
    ]);
    expect(forgot.global.map((item) => item.id)).toEqual(['search', 'forgot']);
  });

  test('enabled が例外を投げても、その登録だけ出さずに続ける', () => {
    const groups = shortcutHelpGroups([
      shortcut('broken', {
        enabled: () => {
          throw new Error('部品が外れた');
        },
      }),
      shortcut('fine'),
    ]);
    expect(groups.screen.map((item) => item.id)).toEqual(['fine']);
  });

  test('同じ id は1回だけ出す', () => {
    const groups = shortcutHelpGroups([shortcut('a'), shortcut('a')]);
    expect(groups.screen).toHaveLength(1);
  });

  test('登録が空なら両方空', () => {
    expect(shortcutHelpGroups([])).toEqual({ screen: [], global: [] });
  });
});
