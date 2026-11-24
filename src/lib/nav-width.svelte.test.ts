import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clampNavWidth,
  handleNavWidthStorage,
  listenNavWidthStorage,
  navWidthMax,
  navWidthState,
  NAV_WIDTH_DEFAULT,
  NAV_WIDTH_KEY,
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  parseNavWidth,
  readNavWidth,
  setNavWidth,
} from './nav-width.svelte.ts';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  vi.unstubAllGlobals();
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  navWidthState.width = NAV_WIDTH_DEFAULT;
});

function storage(value: string | null = null) {
  const values = new Map<string, string>();
  if (value !== null) values.set(NAV_WIDTH_KEY, value);
  const store = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, next: string) => values.set(key, next)),
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

describe('左のメニューの幅の範囲', () => {
  test('既定は 240px、下限は 200px、上限は 480px', () => {
    expect([NAV_WIDTH_DEFAULT, NAV_WIDTH_MIN, NAV_WIDTH_MAX]).toEqual([240, 200, 480]);
  });

  test('画面の幅での上限は min(480px, 40vw) を切り捨て、下限より細くしない', () => {
    expect(navWidthMax(1440)).toBe(480);
    expect(navWidthMax(1200)).toBe(480);
    expect(navWidthMax(1000)).toBe(400);
    expect(navWidthMax(761)).toBe(304);
    expect(navWidthMax(762.5)).toBe(305);
    expect(navWidthMax(300)).toBe(200);
    expect(navWidthMax(0)).toBe(480);
    expect(navWidthMax(Number.NaN)).toBe(480);
  });

  test('丸めて範囲に収める', () => {
    expect(clampNavWidth(199)).toBe(200);
    expect(clampNavWidth(-50)).toBe(200);
    expect(clampNavWidth(300.4)).toBe(300);
    expect(clampNavWidth(300.5)).toBe(301);
    expect(clampNavWidth(481)).toBe(480);
    expect(clampNavWidth(Number.POSITIVE_INFINITY)).toBe(240);
    expect(clampNavWidth(Number.NaN)).toBe(240);
    expect(clampNavWidth(400, 800)).toBe(320);
    expect(clampNavWidth(150, 800)).toBe(200);
  });
});

describe('覚えた幅の読み方', () => {
  test('数字だけの値を範囲に収め、それ以外は既定に戻す', () => {
    expect(parseNavWidth('320')).toBe(320);
    expect(parseNavWidth('100')).toBe(200);
    expect(parseNavWidth('9999')).toBe(480);
    expect(parseNavWidth('0')).toBe(200);
    for (const bad of [null, '', '320px', '320.5', ' 320', '-300', '1e3', 'abc', '99999']) {
      expect(parseNavWidth(bad)).toBe(240);
    }
  });

  test('未設定と localStorage が使えない端末は既定の幅', () => {
    storage();
    expect(readNavWidth()).toBe(240);
    storage('360');
    expect(readNavWidth()).toBe(360);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(readNavWidth()).toBe(240);
  });
});

describe('幅を変える', () => {
  test('範囲に収めて覚える', () => {
    const store = storage();
    setNavWidth(333.6);
    expect(navWidthState.width).toBe(334);
    expect(store.setItem).toHaveBeenLastCalledWith(NAV_WIDTH_KEY, '334');
    setNavWidth(1000);
    expect(store.setItem).toHaveBeenLastCalledWith(NAV_WIDTH_KEY, '480');
  });

  test('画面の幅を渡すと、その上限に収める', () => {
    const store = storage();
    setNavWidth(450, { viewportWidth: 900 });
    expect(navWidthState.width).toBe(360);
    expect(store.setItem).toHaveBeenLastCalledWith(NAV_WIDTH_KEY, '360');
  });

  test('ドラッグの間（persist: false）は覚えずに見た目だけを変える', () => {
    const store = storage();
    setNavWidth(300, { persist: false });
    expect(navWidthState.width).toBe(300);
    expect(store.setItem).not.toHaveBeenCalled();
  });

  test('保存が失敗しても落ちず、幅は替わる', () => {
    const store = storage();
    store.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setNavWidth(280)).not.toThrow();
    expect(navWidthState.width).toBe(280);
  });
});

describe('別のタブの変更を追う', () => {
  test('同じキーの値を読み方に通して当て、ほかのキーは見ない', () => {
    const store = storage();
    handleNavWidthStorage({ key: NAV_WIDTH_KEY, newValue: '300', storageArea: store as unknown as Storage });
    expect(navWidthState.width).toBe(300);
    handleNavWidthStorage({ key: 'other', newValue: '400', storageArea: store as unknown as Storage });
    expect(navWidthState.width).toBe(300);
    handleNavWidthStorage({ key: NAV_WIDTH_KEY, newValue: 'bad', storageArea: store as unknown as Storage });
    expect(navWidthState.width).toBe(240);
  });

  test('消去と clear() は既定に戻す', () => {
    const store = storage();
    navWidthState.width = 400;
    handleNavWidthStorage({ key: NAV_WIDTH_KEY, newValue: null, storageArea: store as unknown as Storage });
    expect(navWidthState.width).toBe(240);
    navWidthState.width = 400;
    handleNavWidthStorage({ key: null, newValue: null, storageArea: store as unknown as Storage });
    expect(navWidthState.width).toBe(240);
  });

  test('sessionStorage の変更は見ない', () => {
    storage();
    navWidthState.width = 400;
    const session = {} as Storage;
    handleNavWidthStorage({ key: null, newValue: null, storageArea: session });
    handleNavWidthStorage({ key: NAV_WIDTH_KEY, newValue: '300', storageArea: session });
    expect(navWidthState.width).toBe(400);
  });

  test('storage のイベントに登録する', () => {
    const target = { addEventListener: vi.fn() };
    listenNavWidthStorage(target);
    expect(target.addEventListener).toHaveBeenCalledWith('storage', handleNavWidthStorage);
  });
});
