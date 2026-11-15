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
// 変数名と端末の安全領域の名前だけを外し、予備値は検査に残す（var(--space-2, 9px) の 9px を見るため）
const VAR_HEAD = /var\(\s*--[\w-]+\s*,?/gi;
const ENV_HEAD = /env\(\s*[\w-]+\s*,?/gi;
// 括弧を含まない予備値。中の長さは罫の例外を当てずに見る
const FALLBACK = /(?:var\(\s*--[\w-]+|env\(\s*[\w-]+)\s*,([^()]*)\)/gi;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

// 波括弧の入れ子を追い、宣言ごとに外側の @ 規則とセレクタを添えて返す。
// 文字列（エスケープを含む）と括弧の中の ; { } と /* は区切りに数えない（content: "a;b" や url(data:…;base64,…) で宣言が切れないように）
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
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (quote) {
      buffer += char;
      if (char === '\\') buffer += css[++i] ?? '';
      else if (char === quote) quote = '';
    } else if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) throw new Error('コメントが閉じていない');
      // CSS のコメントは字句の区切りなので空白に置き換える（0px/**/7px の 7px を 0px7px として見落とさないため）
      buffer += ' ';
      i = end + 1;
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
  // 閉じ忘れたまま読み終えると、その後ろの宣言をすべて読み落とし、許可リストの全件が「残っている」と誤って案内される
  if (quote) throw new Error('文字列が閉じていない');
  if (parens !== 0) throw new Error('括弧が閉じていない');
  if (stack.length > 0) throw new Error('波括弧が閉じていない');
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

// 長さの隣（空白を除く前後の1文字）の演算子。乗除を足し引きより先に見る
function neighbor(text: string, start: number, end: number): Operator {
  const sides = [text.slice(0, start).trimEnd().at(-1), text.slice(end).trimStart()[0]];
  if (sides.some((char) => char === '*' || char === '/')) return 'multiply';
  if (sides.some((char) => char === '+' || char === '-')) return 'add';
  return 'none';
}

const nonZero = (match: RegExpMatchArray) => Math.abs(Number(match[1])) !== 0;

// 刻みの外なら理由を、刻みの中なら null を返す。通すのは tokens.css の変数、0、±1px（罫）、端末の安全領域の名前、単位の無い数。
// 1px を掛けたり割ったり足し合わせたりすれば任意の長さを作れるので、±1px を通すのは、乗除の隣に無く、足し引きに使うのが値の中で1つだけのとき。
// 予備値（var(--space-2, 1px)、env(…, 1px)）には罫の例外を当てない
export function spacingProblem(value: string, tokens: Set<string>): string | null {
  const unknown = [...value.matchAll(VAR_NAME)].map((match) => match[1]).filter((name) => !tokens.has(name));
  if (unknown.length > 0) return `余白の段でない変数 ${unknown.join('、')}`;
  const fallbacks = [...value.matchAll(FALLBACK)].map((match) => match[1]);
  const fallbackRaw = fallbacks.flatMap((text) => [...text.matchAll(LENGTH)].filter(nonZero).map((match) => match[0]));
  const rest = unwrap(value.replace(FALLBACK, ' ').replace(VAR_HEAD, ' ').replace(ENV_HEAD, ' '));
  const lengths = [...rest.matchAll(LENGTH)].filter(nonZero).map((match) => ({
    text: match[0],
    hairline: Math.abs(Number(match[1])) === 1 && match[2].toLowerCase() === 'px',
    operator: neighbor(rest, match.index, match.index + match[0].length),
  }));
  const added = lengths.filter(({ hairline, operator }) => hairline && operator === 'add').length;
  const raw = lengths
    .filter(({ hairline, operator }) => !hairline || operator === 'multiply' || (operator === 'add' && added > 1))
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
