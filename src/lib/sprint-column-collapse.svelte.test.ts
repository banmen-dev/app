import { afterEach, describe, expect, test, vi } from 'vitest';
import { SprintColumnCollapse, sprintColumnCollapseKey } from './sprint-column-collapse.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const values = new Map<string, string>();
  const store = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

describe('スプリントの列の開閉', () => {
  test('ワークスペースが無い間は保存領域を読まず、書かない', () => {
    const store = storage();
    const state = new SprintColumnCollapse('');
    state.toggle('done');
    expect(store.getItem).not.toHaveBeenCalled();
    expect(store.setItem).not.toHaveBeenCalled();
    expect(state.ids).toEqual([]);
  });
  test('再作成しても記憶し、別のワークスペースには及ばず、開くと保存を外す', () => {
    storage();
    const state = new SprintColumnCollapse('a');
    state.toggle('todo');
    state.toggle('done');
    expect(new SprintColumnCollapse('a').ids).toEqual(['todo', 'done']);
    expect(new SprintColumnCollapse('b').ids).toEqual([]);
    state.toggle('todo');
    expect(new SprintColumnCollapse('a').ids).toEqual(['done']);
    expect(state.isCollapsed('deleted-or-new-column')).toBe(false);
  });

  test.each(['oops', '{}', '[1]', '["done",null]'])('不正な保存値 %s は既定で開く', (value) => {
    const store = storage();
    store.setItem(sprintColumnCollapseKey('a'), value);
    expect(new SprintColumnCollapse('a').ids).toEqual([]);
  });

  test('保存領域の取得・読み書きが拒否されても今の画面では開閉する', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    const state = new SprintColumnCollapse('a');
    state.toggle('done');
    expect(state.isCollapsed('done')).toBe(true);
    state.toggle('done');
    expect(state.isCollapsed('done')).toBe(false);
    const store = storage();
    store.getItem.mockImplementation(() => {
      throw new Error('read');
    });
    store.setItem.mockImplementation(() => {
      throw new Error('write');
    });
    const denied = new SprintColumnCollapse('a');
    expect(() => denied.toggle('done')).not.toThrow();
    expect(denied.isCollapsed('done')).toBe(true);
  });

  test('他タブの変更と削除を反映し、不正値・他workspace・sessionStorageは無視する', () => {
    const store = storage();
    const state = new SprintColumnCollapse('a');
    state.handleStorage({ key: state.key, newValue: '["done","done"]', storageArea: store as unknown as Storage });
    expect(state.ids).toEqual(['done']);
    state.handleStorage({ key: state.key, newValue: 'invalid' });
    state.handleStorage({ key: sprintColumnCollapseKey('b'), newValue: '[]' });
    state.handleStorage({ key: null, newValue: null, storageArea: {} as Storage });
    expect(state.ids).toEqual(['done']);
    state.handleStorage({ key: state.key, newValue: null });
    expect(state.ids).toEqual([]);
    state.toggle('done');
    state.handleStorage({ key: null, newValue: null });
    expect(state.ids).toEqual([]);
  });

  test('storageイベントを購読し、ページを離れたら解除する', () => {
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const state = new SprintColumnCollapse('a');
    const stop = state.listen(target);
    expect(target.addEventListener).toHaveBeenCalledWith('storage', expect.any(Function));
    stop();
    expect(target.removeEventListener).toHaveBeenCalledWith('storage', target.addEventListener.mock.calls[0][1]);
  });
});
