// 画面の自己レビューの採点役に渡す設計文書の抜粋。docs/design.md は大きく、採点役は全文を読めないので、
// 採点の根拠になる節だけを見出しの名前で抜き出して周に残す。
export const DESIGN_RULE_HEADINGS = ['## デザイン原則', '### どのテーマにも共通すること'] as const;

function headingDepth(line: string): number | null {
  const match = /^(#{1,6}) /.exec(line);
  return match ? match[1].length : null;
}

// 見出しの完全一致で節を探し、同じ深さか浅い次の見出しの手前までを返す。
// 見出しが0件か2件以上、本文が空のときは、見出しの名前を添えて例外を投げる。
export function extractDesignSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n').map((line) => line.replace(/\r$/, ''));
  const starts = lines.flatMap((line, index) => (line.trimEnd() === heading ? [index] : []));
  if (starts.length === 0) throw new Error(`docs/design.md に見出し「${heading}」がありません`);
  if (starts.length > 1) throw new Error(`docs/design.md に見出し「${heading}」が${starts.length}件あります`);
  const start = starts[0];
  const depth = headingDepth(heading) ?? 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const next = headingDepth(lines[index]);
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
