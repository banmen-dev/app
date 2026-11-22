// 動きを減らす設定（prefers-reduced-motion: reduce）か
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
