// 余白の刻み（DESIGN.md の「余白」）。design/components.css の padding、margin、gap には tokens.css の変数だけを書く。
// 今ある刻みの外の値は design-spacing-allowlist.json に凍結し、新しく足した値と、直したのにリストに残った値で落とす。
// リストの行は文字列か、理由を添えた { "entry": …, "reason": … }（押せる範囲などで刻みの外を残すとき）。
// 同じ組が2か所にあれば、リストにも同じ行を2つ書く
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { declarations, spacingEntries, spacingProblem, spacingTokens } from './design-spacing.ts';

type AllowEntry = string | { entry: string; reason: string };

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('余白の刻みの判定', () => {
  const tokens = new Set(['--space-half', '--space-1', '--space-2', '--space-4']);
  const check = (value: string) => spacingProblem(value, tokens);
  const found = (css: string) => [...spacingEntries(css, tokens)].map(([entry, { count }]) => [entry, count]);

  test('トークンと、それを使った calc() と max() は通す', () => {
    assert.equal(check('var(--space-2)'), null);
    assert.equal(check('var(--space-1) var(--space-2) 0 auto'), null);
    assert.equal(check('calc(-1 * var(--space-2))'), null);
    assert.equal(check('max(var(--space-4), env(safe-area-inset-left, 0px))'), null);
  });

  test('0 と ±1px（罫）と端末の安全領域は通す', () => {
    assert.equal(check('0'), null);
    assert.equal(check('1px var(--space-2)'), null);
    assert.equal(check('-1px'), null);
    assert.equal(check('0px'), null);
    assert.equal(check('calc(var(--space-4) + env(safe-area-inset-bottom, 0px))'), null);
    assert.equal(check('calc(var(--space-4) - 1px)'), null);
  });

  test('刻みの外の値と、刻みに乗っていても直書きの値は落とす', () => {
    assert.equal(check('6px'), '直書きの 6px');
    assert.equal(check('4px'), '直書きの 4px');
    assert.equal(check('7px var(--space-2)'), '直書きの 7px');
    assert.equal(check('calc(44px + var(--space-4))'), '直書きの 44px');
    assert.equal(check('0.3em'), '直書きの 0.3em');
    assert.equal(check('-2px calc(-1 * var(--space-2))'), '直書きの -2px');
    assert.equal(check('1em'), '直書きの 1em');
    assert.equal(check('0.5px'), '直書きの 0.5px');
  });

  test('単位の大文字と、どの単位の直書きも落とす', () => {
    assert.equal(check('6PX'), '直書きの 6PX');
    assert.equal(check('2cqw'), '直書きの 2cqw');
    assert.equal(check('1lh'), '直書きの 1lh');
    assert.equal(check('6pt'), '直書きの 6pt');
    assert.equal(check('1e1px'), '直書きの 1e1px');
  });

  test('var() と env() の予備値の直書きは落とす', () => {
    assert.equal(check('var(--space-2, 9px)'), '直書きの 9px');
    assert.equal(check('env(safe-area-inset-left, 13px)'), '直書きの 13px');
  });

  test('1px を掛けたり割ったりして作った値は落とす', () => {
    assert.equal(check('calc(1px * 7)'), '直書きの 1px');
    assert.equal(check('calc(6 * 1px)'), '直書きの 1px');
    assert.equal(check('calc((1px) * 7)'), '直書きの 1px');
    assert.equal(check('calc(7 * (1px))'), '直書きの 1px');
    assert.equal(check('calc(1px + 1px + 1px)'), '直書きの 1px、1px、1px');
  });

  test('予備値の 1px は罫として通さない', () => {
    assert.equal(check('var(--space-2, 1px)'), '直書きの 1px');
    assert.equal(check('env(safe-area-inset-bottom, 1px)'), '直書きの 1px');
  });

  test('余白の段でない変数は落とす', () => {
    assert.equal(check('var(--row-indent)'), '余白の段でない変数 --row-indent');
  });

  test('余白に使える変数は --space-* と、それを使って組んだ tokens.css の変数だけ', () => {
    const names = spacingTokens(`
      :root {
        --space-1: 4px;
        --radius-full: 999px;
        --mobile-tab-size: 48px;
        --bar: calc(var(--mobile-tab-size) + 2 * var(--space-1));
        --clearance: calc(var(--bar) + var(--space-1));
      }`);
    assert.deepEqual([...names].sort(), ['--bar', '--clearance', '--space-1']);
    assert.equal(spacingProblem('var(--radius-full)', names), '余白の段でない変数 --radius-full');
    assert.equal(spacingProblem('var(--mobile-tab-size)', names), '余白の段でない変数 --mobile-tab-size');
    assert.equal(spacingProblem('var(--clearance)', names), null);
  });

  test('宣言に @ 規則とセレクタを添え、余白の属性だけを拾う', () => {
    const css = `
      /* gap: 3px は注釈 */
      .a { gap: 6px; width: 10px; }
      @media (max-width: 760px) { .b, .c { padding-inline: 5px var(--space-1); margin: 0; } }`;
    assert.deepEqual(found(css), [
      ['.a | gap: 6px', 1],
      ['@media (max-width: 760px) | .b, .c | padding-inline: 5px var(--space-1)', 1],
    ]);
  });

  test('プロパティ名と関数名の大文字小文字を区別しない', () => {
    assert.deepEqual(found('.a { PADDING: 7px; Gap: 5px; }'), [
      ['.a | padding: 7px', 1],
      ['.a | gap: 5px', 1],
    ]);
    assert.equal(check('VAR(--nope)'), '余白の段でない変数 --nope');
    assert.equal(check('Var(--space-2, 9px)'), '直書きの 9px');
    assert.equal(check('ENV(safe-area-inset-left, 0px)'), null);
  });

  test('grid-gap の古い名前も拾う', () => {
    assert.deepEqual(found('.a { grid-gap: 5px; grid-row-gap: 7px; }'), [
      ['.a | grid-gap: 5px', 1],
      ['.a | grid-row-gap: 7px', 1],
    ]);
  });

  test('同じ組が2か所にあれば2つと数える', () => {
    assert.deepEqual(found('.btn { gap: 6px; } .btn { gap: 6px; }'), [['.btn | gap: 6px', 2]]);
  });

  test('文字列と括弧の中の ; { } で宣言を切らない', () => {
    assert.deepEqual(found('.a { content: "a; }"; gap: 3px; }'), [['.a | gap: 3px', 1]]);
    assert.deepEqual(found('.a { content: "a; padding: 6px"; }'), []);
    assert.deepEqual(found('.a { background: url(data:x;padding:6px); gap: 5px; }'), [['.a | gap: 5px', 1]]);
    assert.deepEqual(found('.a[data-x="}"] { padding: 6px; }'), [['.a[data-x="}"] | padding: 6px', 1]]);
  });

  test('文字列の中のエスケープとコメントの記号で、後ろの宣言を読み落とさない', () => {
    assert.deepEqual(found('.z::before { content: "\\""; } .b { padding: 6px; }'), [['.b | padding: 6px', 1]]);
    assert.deepEqual(found('.a::before { content: "/*"; } .b { padding: 6px; } .c::after { content: "*/"; }'), [
      ['.b | padding: 6px', 1],
    ]);
  });

  test('コメントは字句の区切りとして扱い、前後をつなげない', () => {
    assert.deepEqual(found('.a { padding: 0px/**/7px; }'), [['.a | padding: 0px 7px', 1]]);
  });

  test('入れ子のセレクタは外側から順につなぐ', () => {
    assert.deepEqual(found('.a { &:hover { padding: 7px; } }'), [['.a &:hover | padding: 7px', 1]]);
  });

  test('括弧が閉じていない CSS は、読み落とさずに止める', () => {
    assert.throws(() => found('.a { padding: calc(6px; } .b { padding: 7px; }'), /括弧が閉じていない/);
    assert.throws(() => found('.a::before { content: "x; } .b { padding: 7px; }'), /文字列が閉じていない/);
    assert.throws(() => found('.a { padding: 0; } /* .b { padding: 7px; }'), /コメントが閉じていない/);
    assert.throws(() => found('.a { padding: 0; .b { padding: 7px; }'), /波括弧が閉じていない/);
  });

  test('components.css で余白の段を上書きする宣言は落とす', () => {
    assert.deepEqual(found('.a { --space-2: 5px; padding: var(--space-2); }'), [['.a | --space-2: 5px', 1]]);
  });
});

describe('design/components.css の余白', () => {
  const tokens = spacingTokens(read('../design/tokens.css'));
  const found = spacingEntries(read('../design/components.css'), tokens);
  const list = JSON.parse(read('./design-spacing-allowlist.json')) as AllowEntry[];
  const allowed = new Map<string, number>();
  for (const item of list) {
    const entry = typeof item === 'string' ? item : item.entry;
    allowed.set(entry, (allowed.get(entry) ?? 0) + 1);
  }

  test('許可リストの行は、文字列か、空でない理由を添えた形', () => {
    const broken = list.filter(
      (item) =>
        typeof item !== 'string' &&
        !(typeof item?.entry === 'string' && typeof item.reason === 'string' && item.reason.trim() !== ''),
    );
    assert.deepEqual(broken, [], '許可リストの行は "<行>" か { "entry": "<行>", "reason": "<理由の節>" } で書く');
  });

  test('刻みの外の値を新しく書いていない', () => {
    const added = [...found]
      .filter(([entry, { count }]) => count > (allowed.get(entry) ?? 0))
      .map(([entry, { problem, count }]) => `${entry}（${problem}。${count} か所）`);
    assert.deepEqual(
      added,
      [],
      `刻みの外の余白がある。var(--space-*) で書き直す（DESIGN.md の「余白」）。押せる範囲などで刻みの外が要るときは、理由を docs/design.md に書いて scripts/design-spacing-allowlist.json に足す:\n${added.join('\n')}`,
    );
  });

  test('許可リストに、もう無い値が残っていない', () => {
    const stale = [...allowed]
      .filter(([entry, count]) => count > (found.get(entry)?.count ?? 0))
      .map(([entry]) => entry);
    assert.deepEqual(
      stale,
      [],
      `刻みに直したか消した値が、scripts/design-spacing-allowlist.json に残っている。リストから消す:\n${stale.join('\n')}`,
    );
  });
});

// DESIGN.md は段の表に値を写して持つので、tokens.css だけを直すと表が古いまま残る
describe('DESIGN.md の余白と文字の段の表', () => {
  const rootPx = new Map(
    declarations(read('../design/tokens.css'))
      .filter(
        ({ context, selector, property }) =>
          context === '' && selector === ':root' && /^--(?:space|text)-/.test(property),
      )
      .map(({ property, value }) => {
        const [, number, unit] = /^([\d.]+)(px|rem)$/.exec(value) ?? [];
        assert.ok(number, `${property}: ${value} を px か rem として読めない`);
        return [property, unit === 'rem' ? Number(number) * 16 : Number(number)] as const;
      }),
  );
  const tablePx = new Map(
    [...read('../DESIGN.md').matchAll(/^\| `(--(?:space|text)-[\w-]+)` \| (\d+)px \|/gm)].map(
      ([, name, px]) => [name, Number(px)] as const,
    ),
  );

  test('tokens.css の --space-* と --text-* が、表にすべて同じ値で載っている', () => {
    assert.ok(rootPx.size > 0, 'tokens.css の :root から --space-* と --text-* を読めない');
    assert.deepEqual(Object.fromEntries(tablePx), Object.fromEntries(rootPx));
  });
});
