// 余白の刻み（DESIGN.md の「余白」）。design/components.css の padding、margin、gap には tokens.css の変数だけを書く。
// 今ある刻みの外の値は design-spacing-allowlist.json に凍結し、新しく足した値と、直したのにリストに残った値で落とす。
// リストの行は文字列か、理由を添えた { "entry": …, "reason": … }（押せる範囲などで刻みの外を残すとき）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { spacingEntries, spacingProblem, tokenNames } from './design-spacing.ts';

type AllowEntry = string | { entry: string; reason?: string };

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('余白の刻みの判定', () => {
  const tokens = new Set(['--space-half', '--space-1', '--space-2', '--space-4']);
  const check = (value: string) => spacingProblem(value, tokens);

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
  });

  test('刻みの外の値と、刻みに乗っていても直書きの値は落とす', () => {
    assert.equal(check('6px'), '直書きの 6px');
    assert.equal(check('4px'), '直書きの 4px');
    assert.equal(check('7px var(--space-2)'), '直書きの 7px');
    assert.equal(check('calc(44px + var(--space-4))'), '直書きの 44px');
    assert.equal(check('0.3em'), '直書きの 0.3em');
    assert.equal(check('-2px calc(-1 * var(--space-2))'), '直書きの -2px');
  });

  test('tokens.css に無い変数は落とす', () => {
    assert.equal(check('var(--row-indent)'), 'tokens.css に無い変数 --row-indent');
  });

  test('宣言に @ 規則とセレクタを添え、余白の属性だけを拾う', () => {
    const css = `
      /* gap: 3px は注釈 */
      .a { gap: 6px; width: 10px; content: "x;y"; background: url(data:image/png;base64,AA); }
      @media (max-width: 760px) { .b, .c { padding-inline: 5px var(--space-1); margin: 0; } }`;
    assert.deepEqual(
      [...spacingEntries(css, tokens)],
      [
        ['.a | gap: 6px', '直書きの 6px'],
        ['@media (max-width: 760px) | .b, .c | padding-inline: 5px var(--space-1)', '直書きの 5px'],
      ],
    );
  });
});

describe('design/components.css の余白', () => {
  const tokens = tokenNames(read('../design/tokens.css'));
  const found = spacingEntries(read('../design/components.css'), tokens);
  const allowed = new Set(
    (JSON.parse(read('./design-spacing-allowlist.json')) as AllowEntry[]).map((item) =>
      typeof item === 'string' ? item : item.entry,
    ),
  );

  test('刻みの外の値を新しく書いていない', () => {
    const added = [...found]
      .filter(([entry]) => !allowed.has(entry))
      .map(([entry, problem]) => `${entry}（${problem}）`);
    assert.deepEqual(
      added,
      [],
      `刻みの外の余白がある。var(--space-*) で書き直す（DESIGN.md の「余白」）。押せる範囲などで刻みの外が要るときは、理由を docs/design.md に書いて scripts/design-spacing-allowlist.json に足す:\n${added.join('\n')}`,
    );
  });

  test('許可リストに、もう無い値が残っていない', () => {
    const stale = [...allowed].filter((entry) => !found.has(entry));
    assert.deepEqual(
      stale,
      [],
      `刻みに直したか消した値が、scripts/design-spacing-allowlist.json に残っている。リストから消す:\n${stale.join('\n')}`,
    );
  });
});
