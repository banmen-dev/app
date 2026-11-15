// 余白の刻みの判定（DESIGN.md の「余白」）。design/components.css の padding、margin、gap に、tokens.css の変数を通さない値が無いかを見る。
// 検査は design-spacing.test.ts が、今ある値を凍結した design-spacing-allowlist.json と突き合わせて行う

export type Declaration = { context: string; selector: string; property: string; value: string };

const SPACING_PROPERTY = /^(?:padding|margin|gap|row-gap|column-gap|scroll-margin|scroll-padding)(?:-[a-z-]+)?$/;
const LENGTH = /(?<![\w-])(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|dvh|svh|lvh|vh|vw|vmin|vmax|ch|ex|%)/g;
const VAR = /var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g;
// 端末の安全領域（env(safe-area-inset-*, 0px)）は端末が決める値なので刻みに数えない
const ENV = /env\([^()]*\)/g;

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

// 波括弧の入れ子を追い、宣言ごとに外側の @ 規則とセレクタを添えて返す。文字列と括弧の中の ; { } は区切りに数えない
// （content: "a;b" や url(data:…;base64,…) で宣言が切れないように）
export function declarations(css: string): Declaration[] {
  const stack: string[] = [];
  const found: Declaration[] = [];
  let buffer = '';
  let quote = '';
  let parens = 0;
  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    const colon = text.indexOf(':');
    const rules = stack.filter((prelude) => !prelude.startsWith('@'));
    if (colon < 0 || rules.length === 0) return;
    found.push({
      context: stack.filter((prelude) => prelude.startsWith('@')).join(' / '),
      selector: rules.join(' '),
      property: text.slice(0, colon).trim().toLowerCase(),
      value: squash(text.slice(colon + 1)),
    });
  };
  for (const char of stripComments(css)) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    } else if (char === '(') {
      parens++;
      buffer += char;
    } else if (char === ')') {
      parens--;
      buffer += char;
    } else if (parens > 0) {
      buffer += char;
    } else if (char === '{') {
      stack.push(squash(buffer));
      buffer = '';
    } else if (char === ';') {
      flush();
    } else if (char === '}') {
      flush();
      stack.pop();
    } else {
      buffer += char;
    }
  }
  return found;
}

export function tokenNames(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
}

// 刻みの外なら理由を、刻みの中なら null を返す。通すのは tokens.css の変数、0、±1px（罫）、端末の安全領域、単位の無い数
export function spacingProblem(value: string, tokens: Set<string>): string | null {
  const unknown = [...value.matchAll(VAR)].map((match) => match[1]).filter((name) => !tokens.has(name));
  if (unknown.length > 0) return `tokens.css に無い変数 ${unknown.join('、')}`;
  const rest = value.replace(VAR, ' ').replace(ENV, ' ');
  const raw = [...rest.matchAll(LENGTH)]
    .filter(([, number, unit]) => {
      const amount = Math.abs(Number(number));
      return !(amount === 0 || (unit === 'px' && amount === 1));
    })
    .map((match) => match[0]);
  return raw.length > 0 ? `直書きの ${raw.join('、')}` : null;
}

export const entryOf = ({ context, selector, property, value }: Declaration) =>
  `${context ? `${context} | ` : ''}${selector} | ${property}: ${value}`;

// 刻みの外の余白を、許可リストの行（entryOf）から理由への対応で返す
export function spacingEntries(css: string, tokens: Set<string>): Map<string, string> {
  const entries = new Map<string, string>();
  for (const declaration of declarations(css)) {
    if (!SPACING_PROPERTY.test(declaration.property)) continue;
    const problem = spacingProblem(declaration.value, tokens);
    if (problem) entries.set(entryOf(declaration), problem);
  }
  return entries;
}
