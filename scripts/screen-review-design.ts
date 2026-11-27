// 画面の自己レビューの採点役に渡す設計文書の抜粋。docs/design.md は大きく、採点役は全文を読めないので、
// 採点の根拠になる節だけを見出しの名前で抜き出して周に残す。
export const DESIGN_RULE_HEADINGS = ['## デザイン原則', '### どのテーマにも共通すること'] as const;

// コードフェンスの中の `#` は見出しにしない。
// 開いたときの記号と長さを覚え、同じ記号で同じ長さ以上、後ろが空白だけの行でだけ閉じる。
// 走査の終わりで開いたままなら、後ろの見出しを黙って隠さないよう例外にする。
function headingDepths(lines: string[]): (number | null)[] {
  let open: { char: string; length: number; line: number } | null = null;
  const depths = lines.map((line, index) => {
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length && fence[2].trim() === '') open = null;
      return null;
    }
    if (fence) {
      open = { char: fence[1][0], length: fence[1].length, line: index + 1 };
      return null;
    }
    const match = /^(#{1,6}) /.exec(line);
    return match ? match[1].length : null;
  });
  if (open) throw new Error(`docs/design.md の${(open as { line: number }).line}行目のコードフェンスが閉じていません`);
  return depths;
}

// 見出しの完全一致で節を探し、同じ深さか浅い次の見出しの手前までを返す。
// 見出しが0件か2件以上、本文が空のときは、見出しの名前を添えて例外を投げる。
// 本文は、見出しの次の行から終わりまでの全体（子見出しの行も含む）。
// 子見出しだけが残って説明が消えた節は、本文ありと数える（扱わないと決めた。
// 抜粋する節は本文を持ち、子見出しだけになる見込みが薄いため）。
export function extractDesignSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n').map((line) => line.replace(/\r$/, ''));
  const depths = headingDepths(lines);
  const starts = lines.flatMap((line, index) => (depths[index] !== null && line.trimEnd() === heading ? [index] : []));
  if (starts.length === 0) throw new Error(`docs/design.md に見出し「${heading}」がありません`);
  if (starts.length > 1) throw new Error(`docs/design.md に見出し「${heading}」が${starts.length}件あります`);
  const start = starts[0];
  const depth = depths[start] ?? 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const next = depths[index];
    if (next !== null && next <= depth) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n');
  if (body.trim() === '') throw new Error(`docs/design.md の見出し「${heading}」の本文が空です`);
  return lines.slice(start, end).join('\n').trimEnd() + '\n';
}

export function extractDesignRules(markdown: string): { headings: string[]; text: string } {
  const sections = DESIGN_RULE_HEADINGS.map((heading) => extractDesignSection(markdown, heading));
  return { headings: [...DESIGN_RULE_HEADINGS], text: sections.join('\n') };
}
