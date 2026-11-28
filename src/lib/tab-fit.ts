// ワークスペースの画面のタブ（WorkspaceTabs）が、幅に入るだけ並べて残りを「その他」にまとめるときの、列に残す数の計算。
// 幅の測りは WorkspaceTabs が行い、ここは数だけを決める（design/kit.js に同じ計算がある。scripts/design-parity.test.ts が突き合わせる）。
//
// widths は各タブの幅（並びの順）、available は帯の幅、gap はタブの間隔、moreWidth は「その他」のボタンの幅（まとめるときだけ並ぶ）。
// 全部が入れば全部を残す。入らなければ、「その他」のボタンの分を空けて入るだけを前から残す（0 もありうる。今の画面のタブも前から数え、
// 「その他」に入るときはボタンの印と一覧の中の項目で伝える）。幅が測れていない（NaN、負）ときは全部を残す
export function fitTabCount(widths: readonly number[], available: number, gap: number, moreWidth: number): number {
  if (!Number.isFinite(available) || available <= 0) return widths.length;
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.length;
  let used = moreWidth;
  let count = 0;
  for (const width of widths) {
    used += gap + width;
    if (used > available) break;
    count += 1;
  }
  return count;
}
