// 左のメニューの幅の範囲と、覚えた値の読み方（#1513）。状態（runes）を持たないので、scripts/ の node --test からも読む。
// 状態と保存は nav-width.svelte.ts。最初の読み込みの骨組み（static/boot-shape.js）も同じキーと読み方にする（scripts/boot-shape.test.ts が突き合わせる）
export const NAV_WIDTH_KEY = 'sg-nav-width';
export const NAV_WIDTH_DEFAULT = 240;
export const NAV_WIDTH_MIN = 200;
export const NAV_WIDTH_MAX = 480;
// 画面の幅に対する上限の割合（40vw）。本文の読む幅を残すため
export const NAV_WIDTH_VIEWPORT_RATIO = 0.4;
// 矢印キーの1回で変える幅
export const NAV_WIDTH_STEP = 16;

// 画面の幅での上限。min(480px, 40vw) を px の整数に切り捨て、下限より細くはしない
export function navWidthMax(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return NAV_WIDTH_MAX;
  return Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, Math.floor(viewportWidth * NAV_WIDTH_VIEWPORT_RATIO)));
}

// 幅を px の整数に丸めて範囲に収める。viewportWidth を渡すと、その画面の幅での上限にも収める
export function clampNavWidth(width: number, viewportWidth?: number): number {
  if (!Number.isFinite(width)) return NAV_WIDTH_DEFAULT;
  const max = viewportWidth === undefined ? NAV_WIDTH_MAX : navWidthMax(viewportWidth);
  return Math.min(max, Math.max(NAV_WIDTH_MIN, Math.round(width)));
}

// 覚えた値を読む。数字だけの文字列（px の整数）を範囲に収め、それ以外（未設定、小数、単位付き、空）は既定に戻す。
// static/boot-shape.js も同じ読み方をする
export function parseNavWidth(value: string | null): number {
  if (value === null || !/^\d{1,4}$/.test(value)) return NAV_WIDTH_DEFAULT;
  return clampNavWidth(Number(value));
}
