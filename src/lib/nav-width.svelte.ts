// 左のメニュー（綴じ）の幅を、右の境目のドラッグと矢印キーで変え、端末に覚える（#1513）。
// 最初の読み込みの骨組み（static/boot-shape.js）も同じキーと読み方で幅を当てるので、変えるときは合わせる（scripts/boot-shape.test.ts）。
// 覚えるのは px の整数で、画面の幅による上限（40vw）は覚えずに CSS（design/components.css の .app の --binding-width）と aria-valuemax で当てる。
// 細い窓で縮んで見えても、広い窓に戻せば覚えた幅で出すため
import { NAV_WIDTH_DEFAULT, NAV_WIDTH_KEY, clampNavWidth, parseNavWidth } from './nav-width.ts';

export {
  NAV_WIDTH_DEFAULT,
  NAV_WIDTH_KEY,
  NAV_WIDTH_MAX,
  NAV_WIDTH_MIN,
  NAV_WIDTH_STEP,
  NAV_WIDTH_VIEWPORT_RATIO,
  NAV_WIDTH_DRAG_THRESHOLD,
  clampNavWidth,
  draggedNavWidth,
  keyedNavWidth,
  releasedNavWidth,
  navWidthMax,
  parseNavWidth,
} from './nav-width.ts';

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function readNavWidth(): number {
  const store = storage();
  if (!store) return NAV_WIDTH_DEFAULT;
  try {
    return parseNavWidth(store.getItem(NAV_WIDTH_KEY));
  } catch {
    return NAV_WIDTH_DEFAULT;
  }
}

export const navWidthState = $state({ width: readNavWidth() });

// ドラッグの間は覚えずに見た目だけを変え（persist: false）、離したときに覚える。覚えられない端末でも今の画面では変わる
export function setNavWidth(
  width: number,
  { persist = true, viewportWidth }: { persist?: boolean; viewportWidth?: number } = {},
): void {
  const next = clampNavWidth(width, viewportWidth);
  navWidthState.width = next;
  if (!persist) return;
  try {
    storage()?.setItem(NAV_WIDTH_KEY, String(next));
  } catch {
    // 容量超過や拒否は、覚えないだけにする
  }
}

// 別のタブでの変更を追う。key が null なのは別のタブの localStorage.clear() で、既定に戻す。
// sessionStorage の変更も storage のイベントで届くので、localStorage のものだけを見る（nav-collapse.svelte.ts と同じ扱い）
export function handleNavWidthStorage(event: {
  key: string | null;
  newValue: string | null;
  storageArea?: Storage | null;
}): void {
  if (event.storageArea !== undefined && event.storageArea !== storage()) return;
  if (event.key !== null && event.key !== NAV_WIDTH_KEY) return;
  navWidthState.width = parseNavWidth(event.key === null ? null : event.newValue);
}

export function listenNavWidthStorage(target: Pick<Window, 'addEventListener'>): void {
  target.addEventListener('storage', handleNavWidthStorage);
}

if (typeof window !== 'undefined') listenNavWidthStorage(window);
