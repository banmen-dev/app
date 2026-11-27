// 左のメニューを閉じた（列を残さず本文を全幅にする。#1512）かを端末に覚える。キーの名前は畳んだ列の頃のまま使う。
// 最初の読み込みの骨組み（static/boot-shape.js）も読むので、変えるときは合わせる（scripts/boot-shape.test.ts）
export const NAV_COLLAPSED_KEY = 'sg-nav-collapsed';
// 左のメニュー（nav）の id。開閉のボタンの aria-controls が指す
export const NAV_MENU_ID = 'app-nav';
// 左のメニューの「ワークスペース」の一覧（見出しのボタンの aria-controls が指す）と、その一覧を畳んだか（#1515）を端末に覚えるキー。
// 左のメニューの開閉とは別に覚える。既定は開いた状態
export const NAV_WORKSPACES_ID = 'app-nav-workspaces';
export const NAV_WORKSPACES_COLLAPSED_KEY = 'sg-nav-workspaces-collapsed';

function isCollapsedValue(value: string | null): boolean {
  return value === 'true';
}

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function readFlag(key: string): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return isCollapsedValue(store.getItem(key));
  } catch {
    return false;
  }
}

export function readNavCollapsed(): boolean {
  return readFlag(NAV_COLLAPSED_KEY);
}

export function readNavWorkspacesCollapsed(): boolean {
  return readFlag(NAV_WORKSPACES_COLLAPSED_KEY);
}

export const navState = $state({ collapsed: readNavCollapsed() });
export const navWorkspacesState = $state({ collapsed: readNavWorkspacesCollapsed() });

// 畳んだ（閉じた）かを、今の画面に当てて端末に覚える。覚えられない端末（localStorage が拒まれる）でも、押したら今の画面では畳める。
// 覚えないだけで、次に開くと開いた状態に戻る
function setCollapsed(target: { collapsed: boolean }, key: string, collapsed: boolean): void {
  target.collapsed = collapsed;
  try {
    storage()?.setItem(key, String(collapsed));
  } catch {
    // 容量超過や拒否は、覚えないだけにする
  }
}

// 左のメニュー全体を開閉する
export function setNavCollapsed(collapsed: boolean): void {
  setCollapsed(navState, NAV_COLLAPSED_KEY, collapsed);
}

// ワークスペースの一覧だけを畳む
export function setNavWorkspacesCollapsed(collapsed: boolean): void {
  setCollapsed(navWorkspacesState, NAV_WORKSPACES_COLLAPSED_KEY, collapsed);
}

// 別のタブでの変更を追う。key が null なのは別のタブの localStorage.clear() で、既定（開いた状態）に戻す。
// 値は 'true' と 'false' と消去（null）だけを当て、それ以外は今の状態を保つ（drawer.svelte.ts と同じ扱い）。
// storage のイベントは sessionStorage の変更でも届き、その clear() も key が null になるので、localStorage のものだけを見る
export function handleNavStorage(event: {
  key: string | null;
  newValue: string | null;
  storageArea?: Storage | null;
}): void {
  if (event.storageArea !== undefined && event.storageArea !== storage()) return;
  if (event.key === null) {
    navState.collapsed = false;
    navWorkspacesState.collapsed = false;
    return;
  }
  const target =
    event.key === NAV_COLLAPSED_KEY ? navState : event.key === NAV_WORKSPACES_COLLAPSED_KEY ? navWorkspacesState : null;
  if (target === null) return;
  if (event.newValue === null || event.newValue === 'false') target.collapsed = false;
  else if (event.newValue === 'true') target.collapsed = true;
}

export function listenNavStorage(target: Pick<Window, 'addEventListener'>): void {
  target.addEventListener('storage', handleNavStorage);
}

if (typeof window !== 'undefined') listenNavStorage(window);
