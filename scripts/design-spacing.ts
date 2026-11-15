// 余白の刻みの判定（DESIGN.md の「余白」）。design/components.css の padding、margin、gap に、tokens.css の変数を通さない値が無いかを見る。
// 検査は design-spacing.test.ts が、今ある値を凍結した design-spacing-allowlist.json と突き合わせて行う

export type Declaration = { context: string; selector: string; property: string; value: string };
export type SpacingEntry = { problem: string; count: number };

const SPACING_PROPERTY =
  /^(?:(?:padding|margin|scroll-margin|scroll-padding)(?:-[a-z-]+)?|(?:grid-)?(?:row-|column-)?gap)$/;
// CSS の単位は大文字小文字を区別しないので、数の後ろの英字か % をすべて長さとして拾う（1e1px のような指数も含める）
const LENGTH = /(?<![\w-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]+|%)/gi;
// 関数名（var、env）は CSS で大文字小文字を区別しないので i を付ける。変数名そのものは区別されるが、i は字の種類にしか効かない
const VAR_NAME = /var\(\s*(--[\w-]+)/gi;
const CALL_HEAD = /(?<![\w-])(?:var|env)\(/gi;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

// 波括弧の入れ子を追い、宣言ごとに外側の @ 規則とセレクタを添えて返す。
// 文字列（エスケープを含む）と括弧の中の ; { } と /* は区切りに数えない（content: "a;b" や url(data:…;base64,…) で宣言が切れないように）
export function declarations(css: string): Declaration[] {
  const stack: string[] = [];
  const found: Declaration[] = [];
  let buffer = '';
  let quote = '';
  let quoteAt = 0;
  // 開いた括弧と波括弧の位置。閉じ忘れたときに、どこで開いたかを示す
  const parens: number[] = [];
  const braces: number[] = [];
  const position = (index: number) => {
    const before = css.slice(0, index).split('\n');
    return `${before.length} 行 ${before.at(-1)!.length + 1} 列`;
  };
  const unclosed = (what: string, index: number) => new Error(`${what}が閉じていない（${position(index)}で開いた）`);
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
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (quote) {
      buffer += char;
      if (char === '\\') buffer += css[++i] ?? '';
      else if (char === quote) quote = '';
    } else if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) throw unclosed('コメント', i);
      // CSS のコメントは字句の区切りなので空白に置き換える（0px/**/7px の 7px を 0px7px として見落とさないため）
      buffer += ' ';
      i = end + 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      quoteAt = i;
      buffer += char;
    } else if (char === '(') {
      parens.push(i);
      buffer += char;
    } else if (char === ')') {
      // 余分な ) は、その後ろの括弧の数え方を狂わせるので、読み進めずに止める
      if (parens.length === 0) throw new Error(`開いていない括弧を閉じている（${position(i)}）`);
      parens.pop();
      buffer += char;
    } else if (parens.length > 0) {
      buffer += char;
    } else if (char === '{') {
      stack.push(squash(buffer));
      braces.push(i);
      buffer = '';
    } else if (char === ';') {
      flush();
    } else if (char === '}') {
      flush();
      stack.pop();
      braces.pop();
    } else {
      buffer += char;
    }
  }
  // 閉じ忘れたまま読み終えると、その後ろの宣言をすべて読み落とし、許可リストの全件が「残っている」と誤って案内される
  if (quote) throw unclosed('文字列', quoteAt);
  if (parens.length > 0) throw unclosed('括弧', parens[0]);
  if (braces.length > 0) throw unclosed('波括弧', braces[0]);
  return found;
}

// 余白に使える変数。--space-* と、それ（またはそれで組んだ変数）を値に使う tokens.css の変数（--mobile-navigation-clearance など）。
// 余白の段と関係の無い --radius-full や --mobile-tab-size は、長さでも余白に使わせない
export function spacingTokens(css: string): Set<string> {
  const definitions = declarations(css).filter(({ property }) => property.startsWith('--'));
  const names = new Set(definitions.map(({ property }) => property).filter((name) => name.startsWith('--space-')));
  for (let size = -1; size !== names.size;) {
    size = names.size;
    for (const { property, value } of definitions) {
      if ([...value.matchAll(VAR_NAME)].some((match) => names.has(match[1]))) names.add(property);
    }
  }
  return names;
}

// 括弧だけで包んだ長さ（(1px)）は、包みを外して隣の演算子を見えるようにする。calc( の括弧は前に名前があるので外さない
const WRAPPED_LENGTH = /(?<![\w-])\(\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:[a-z]+|%))\s*\)/gi;

const unwrap = (text: string) => {
  let current = text;
  for (let previous = ''; previous !== current;) {
    previous = current;
    current = current.replace(WRAPPED_LENGTH, ' $1 ');
  }
  return current;
};

type Operator = 'multiply' | 'add' | 'none';

// 長さの隣（空白を除く前後の1文字）の演算子。乗除を足し引きより先に見る。
// calc() の + と - は両側に空白が要るので、後ろの - に空白が続かなければ次の値の符号（1px -1px）と読む
function neighbor(text: string, start: number, end: number): Operator {
  const before = text.slice(0, start).trimEnd().at(-1);
  const rest = text.slice(end).trimStart();
  const after = rest[0];
  if ([before, after].some((char) => char === '*' || char === '/')) return 'multiply';
  if (before === '+' || before === '-') return 'add';
  if ((after === '+' || after === '-') && /^\s/.test(rest.slice(1))) return 'add';
  return 'none';
}

// 位置を包むいちばん内側の括弧の開きの位置（包む括弧が無ければ -1）。足し引きの 1px は、この括弧の中ごとに数える
function enclosing(text: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && depth-- === 0) return i;
  }
  return -1;
}

// 開き括弧に対応する閉じ括弧の位置（閉じていなければ末尾）
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length;
}

// 位置を包む括弧のどれかが、まるごと掛けたり割ったりされているか（calc(2 * (var(--space-1) + 1px)) の 1px）
function insideMultiplied(text: string, index: number): boolean {
  for (let open = enclosing(text, index); open >= 0; open = enclosing(text, open)) {
    if (neighbor(text, open, closing(text, open) + 1) === 'multiply') return true;
  }
  return false;
}

const nonZero = (match: RegExpMatchArray) => Math.abs(Number(match[1])) !== 0;

// var() と env() を、対応する閉じ括弧まで丸ごと空白に置き換え、予備値（最初の , の後ろ）を取り出す。
// 名前だけを外すと、残った ) が外側の calc( を閉じたように読め、括弧ごとの数え方が狂うため
function stripCalls(value: string): { rest: string; fallbacks: string[] } {
  const fallbacks: string[] = [];
  let rest = value;
  for (let match = CALL_HEAD.exec(rest); match; match = CALL_HEAD.exec(rest)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let comma = -1;
    let close = rest.length;
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) {
        close = i;
        break;
      } else if (rest[i] === ',' && depth === 1 && comma < 0) comma = i;
    }
    if (comma >= 0) fallbacks.push(rest.slice(comma + 1, close));
    rest = `${rest.slice(0, match.index)} ${rest.slice(close + 1)}`;
    CALL_HEAD.lastIndex = 0;
  }
  return { rest, fallbacks };
}

// 刻みの外なら理由を、刻みの中なら null を返す。通すのは tokens.css の変数、0、±1px（罫）、端末の安全領域の名前、単位の無い数。
// 1px を掛けたり割ったり足し合わせたりすれば任意の長さを作れるので、±1px を通すのは、乗除の隣に無く、足し引きに使うのが値の中で1つだけのとき。
// 予備値（var(--space-2, 1px)、env(…, 1px)）には罫の例外を当てない
export function spacingProblem(value: string, tokens: Set<string>): string | null {
  const unknown = [...value.matchAll(VAR_NAME)].map((match) => match[1]).filter((name) => !tokens.has(name));
  if (unknown.length > 0) return `余白の段でない変数 ${unknown.join('、')}`;
  const stripped = stripCalls(value);
  const fallbackRaw = stripped.fallbacks.flatMap((text) =>
    [...text.matchAll(LENGTH)].filter(nonZero).map((match) => match[0]),
  );
  const rest = unwrap(stripped.rest);
  const lengths = [...rest.matchAll(LENGTH)].filter(nonZero).map((match) => ({
    text: match[0],
    hairline: Math.abs(Number(match[1])) === 1 && match[2].toLowerCase() === 'px',
    operator: insideMultiplied(rest, match.index)
      ? ('multiply' as const)
      : neighbor(rest, match.index, match.index + match[0].length),
    group: enclosing(rest, match.index),
  }));
  const added = new Map<number, number>();
  for (const { hairline, operator, group } of lengths) {
    if (hairline && operator === 'add') added.set(group, (added.get(group) ?? 0) + 1);
  }
  const raw = lengths
    .filter(
      ({ hairline, operator, group }) =>
        !hairline || operator === 'multiply' || (operator === 'add' && (added.get(group) ?? 0) > 1),
    )
    .map(({ text }) => text);
  const all = [...fallbackRaw, ...raw];
  return all.length > 0 ? `直書きの ${all.join('、')}` : null;
}

export const entryOf = ({ context, selector, property, value }: Declaration) =>
  `${context ? `${context} | ` : ''}${selector} | ${property}: ${value}`;

// 刻みの外の余白を、許可リストの行（entryOf）ごとの理由と件数で返す。同じ行が2か所にあれば2と数える
export function spacingEntries(css: string, tokens: Set<string>): Map<string, SpacingEntry> {
  const entries = new Map<string, SpacingEntry>();
  for (const declaration of declarations(css)) {
    const problem = declaration.property.startsWith('--space-')
      ? `tokens.css の段 ${declaration.property} を上書きしている`
      : SPACING_PROPERTY.test(declaration.property)
        ? spacingProblem(declaration.value, tokens)
        : null;
    if (!problem) continue;
    const key = entryOf(declaration);
    entries.set(key, { problem, count: (entries.get(key)?.count ?? 0) + 1 });
  }
  return entries;
}

export type AllowlistResult = { broken: unknown[]; added: string[]; stale: string[] };

// 許可リスト（JSON をそのまま渡す）と見つけた組を、件数で突き合わせる。
// 行は "<行>" か { "entry": "<行>", "reason": "<空でない理由>" }。それ以外の行は読み込みで止めず broken に返し、検査の失敗として見せる
export function compareAllowlist(found: Map<string, SpacingEntry>, list: unknown): AllowlistResult {
  const broken: unknown[] = [];
  const allowed = new Map<string, number>();
  for (const item of Array.isArray(list) ? list : (broken.push(list), [])) {
    const entry =
      typeof item === 'string'
        ? item
        : typeof item?.entry === 'string' && typeof item.reason === 'string' && item.reason.trim() !== ''
          ? item.entry
          : null;
    if (entry === null) broken.push(item);
    else allowed.set(entry, (allowed.get(entry) ?? 0) + 1);
  }
  const added = [...found]
    .filter(([entry, { count }]) => count > (allowed.get(entry) ?? 0))
    .map(([entry, { problem, count }]) => `${entry}（${problem}。${count} か所）`);
  const stale = [...allowed].filter(([entry, count]) => count > (found.get(entry)?.count ?? 0)).map(([entry]) => entry);
  return { broken, added, stale };
}
