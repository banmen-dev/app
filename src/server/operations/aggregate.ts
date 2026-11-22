// 集計の結果の読み方。どの操作の集計も共通に使う

// SUM と COUNT の結果を数にする（D1 は整数で返す。null と数でない値は 0 として扱う）。合計を読むどの処理もこれを使う
export function amountOf(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
