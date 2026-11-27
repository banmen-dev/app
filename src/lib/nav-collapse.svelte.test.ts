import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  handleNavCollapsedStorage,
  listenNavCollapsedStorage,
  navState,
  navWorkspacesState,
  NAV_COLLAPSED_KEY,
  NAV_WORKSPACES_COLLAPSED_KEY,
  readNavCollapsed,
  readNavWorkspacesCollapsed,
  setNavCollapsed,
  setNavWorkspacesCollapsed,
} from './nav-collapse.svelte.ts';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  vi.unstubAllGlobals();
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  navState.collapsed = false;
  navWorkspacesState.collapsed = false;
});

function storage(value: string | null = null) {
  const values = new Map<string, string>();
  if (value !== null) values.set(NAV_COLLAPSED_KEY, value);
  const store = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, next: string) => values.set(key, next)),
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

describe('左のメニューの開閉の既定', () => {
  test('未設定と不正な値は開いた状態', () => {
    expect(readNavCollapsed()).toBe(false);
    storage('yes');
    expect(readNavCollapsed()).toBe(false);
  });

  test('閉じた状態を保存し、状態にも反映する', () => {
    const store = storage();
    setNavCollapsed(true);
    expect(store.setItem).toHaveBeenCalledWith(NAV_COLLAPSED_KEY, 'true');
    expect(navState.collapsed).toBe(true);
    setNavCollapsed(false);
    expect(store.setItem).toHaveBeenLastCalledWith(NAV_COLLAPSED_KEY, 'false');
    expect(navState.collapsed).toBe(false);
  });

  test('localStorage が使えないときは開いた状態で読み、押せば今の画面では閉じられる', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(readNavCollapsed()).toBe(false);
    expect(() => setNavCollapsed(true)).not.toThrow();
    expect(navState.collapsed).toBe(true);
  });

  test('保存が失敗しても落ちず、状態は替わる', () => {
    const store = storage();
    store.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setNavCollapsed(true)).not.toThrow();
    expect(navState.collapsed).toBe(true);
  });
});

describe('ほかのタブでの変更', () => {
  test('キーの true と false を当てる', () => {
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'true' });
    expect(navState.collapsed).toBe(true);
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'false' });
    expect(navState.collapsed).toBe(false);
  });

  test('知らない値と別のキーは、今の状態を保つ', () => {
    navState.collapsed = true;
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'unknown' });
    expect(navState.collapsed).toBe(true);
    handleNavCollapsedStorage({ key: 'sg-theme', newValue: 'false' });
    expect(navState.collapsed).toBe(true);
  });

  test('キーの消去（removeItem）と、別のタブの clear() は開いた状態に戻す', () => {
    navState.collapsed = true;
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: null });
    expect(navState.collapsed).toBe(false);
    navState.collapsed = true;
    handleNavCollapsedStorage({ key: null, newValue: null });
    expect(navState.collapsed).toBe(false);
  });

  test('localStorage 以外の保存領域（sessionStorage など）の変更は見ない', () => {
    const local = storage('true');
    navState.collapsed = true;
    const other = { getItem: () => null, setItem: () => undefined };
    handleNavCollapsedStorage({ key: null, newValue: null, storageArea: other as unknown as Storage });
    expect(navState.collapsed).toBe(true);
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'false', storageArea: other as unknown as Storage });
    expect(navState.collapsed).toBe(true);
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'false', storageArea: local as unknown as Storage });
    expect(navState.collapsed).toBe(false);
  });

  test('storage のイベントを受ける', () => {
    const addEventListener = vi.fn();
    listenNavCollapsedStorage({ addEventListener });
    expect(addEventListener).toHaveBeenCalledWith('storage', handleNavCollapsedStorage);
  });
});

test('保存された true を読むと閉じた状態', () => {
  storage('true');
  expect(readNavCollapsed()).toBe(true);
});

describe('ワークスペースの一覧を畳む状態（#1515）', () => {
  test('未設定と不正な値は開いた状態で、畳んだ状態は左のメニューの開閉とは別のキーに覚える', () => {
    expect(readNavWorkspacesCollapsed()).toBe(false);
    storage('true');
    expect(readNavWorkspacesCollapsed()).toBe(false);
    const store = storage();
    setNavWorkspacesCollapsed(true);
    expect(store.setItem).toHaveBeenCalledWith(NAV_WORKSPACES_COLLAPSED_KEY, 'true');
    expect(navWorkspacesState.collapsed).toBe(true);
    expect(navState.collapsed).toBe(false);
    setNavWorkspacesCollapsed(false);
    expect(store.setItem).toHaveBeenLastCalledWith(NAV_WORKSPACES_COLLAPSED_KEY, 'false');
    expect(navWorkspacesState.collapsed).toBe(false);
  });

  test('保存された true は読み直しても畳んだ状態', () => {
    const store = { getItem: (key: string) => (key === NAV_WORKSPACES_COLLAPSED_KEY ? 'true' : null) };
    vi.stubGlobal('localStorage', store);
    expect(readNavWorkspacesCollapsed()).toBe(true);
  });

  test('保存が失敗しても落ちず、今の画面では畳める', () => {
    const store = storage();
    store.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setNavWorkspacesCollapsed(true)).not.toThrow();
    expect(navWorkspacesState.collapsed).toBe(true);
  });

  test('ほかのタブでの変更と clear() を追い、左のメニューの開閉には触れない', () => {
    handleNavCollapsedStorage({ key: NAV_WORKSPACES_COLLAPSED_KEY, newValue: 'true' });
    expect(navWorkspacesState.collapsed).toBe(true);
    expect(navState.collapsed).toBe(false);
    handleNavCollapsedStorage({ key: NAV_WORKSPACES_COLLAPSED_KEY, newValue: 'unknown' });
    expect(navWorkspacesState.collapsed).toBe(true);
    handleNavCollapsedStorage({ key: NAV_WORKSPACES_COLLAPSED_KEY, newValue: null });
    expect(navWorkspacesState.collapsed).toBe(false);
    navState.collapsed = true;
    navWorkspacesState.collapsed = true;
    handleNavCollapsedStorage({ key: null, newValue: null });
    expect(navState.collapsed).toBe(false);
    expect(navWorkspacesState.collapsed).toBe(false);
  });
});
