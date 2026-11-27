// 色のコントラストを、トークンの値から計算して守る（操作部品の枠、お気に入りの星）。
// 地になりうる色の組をすべて、描画に頼らずここで確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (file: string) => readFileSync(new URL(`../design/${file}`, import.meta.url), 'utf8');

// コメントに残した旧い値や旧いブロックを、読まないよう先に空にする
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = stripComments(read('tokens.css'));
const components = stripComments(read('components.css'));

const groundNames = ['bg', 'surface', 'sunken', 'rule', 'accent-soft'] as const;

// 開き括弧の後ろから、対応する閉じ括弧までの中身を返す
function bodyAfter(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(openIndex + 1, i);
  }
  throw new Error('design/tokens.css の波括弧が閉じていない');
}

// セレクタのブロックの中身を返す。:root は共通の値のブロックとシンプル（ライト）の2つがあるので、何番目かを index で選ぶ。
// 数が想定と違えば落とす（CSS は後ろが効くので、重ねて書かれたまま読むと読み間違える）
function readBlock(selector: string, index = 0, expected = 1): string {
  const found: number[] = [];
  for (let at = tokens.indexOf(`${selector} {`); at >= 0; at = tokens.indexOf(`${selector} {`, at + 1)) found.push(at);
  assert.equal(
    found.length,
    expected,
    `design/tokens.css の ${selector} のブロックが ${found.length} 個ある（想定は ${expected} 個。書き方を変えたら、このテストの取り出し方も直す）`,
  );
  return bodyAfter(tokens, found[index] + selector.length + 1);
}

const blocks = {
  'シンプル（ライト）': readBlock(':root', 1, 2),
  'シンプル（ダーク）': readBlock(':root[data-theme="simple_dark"]'),
};

// シンプル（自動）の prefers-color-scheme の側。simple_dark と同じ値を二重に持つ
const autoDarkBlock = (() => {
  const media = tokens.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(media >= 0, 'design/tokens.css に prefers-color-scheme: dark の @media が見つからない');
  assert.equal(
    tokens.indexOf('@media (prefers-color-scheme: dark)', media + 1),
    -1,
    'design/tokens.css に prefers-color-scheme: dark の @media が2つある。1つにまとめる',
  );
  const inner = bodyAfter(tokens, tokens.indexOf('{', media));
  const selector = ':root:not([data-theme]), :root[data-theme="simple"]';
  const at = inner.indexOf(`${selector} {`);
  assert.ok(at >= 0, `@media (prefers-color-scheme: dark) の中に ${selector} が見つからない`);
  assert.equal(
    inner.indexOf(`${selector} {`, at + 1),
    -1,
    `@media (prefers-color-scheme: dark) の中に ${selector} が2つある。1つにまとめる`,
  );
  return bodyAfter(inner, at + selector.length + 1);
})();

const hex = /^#[0-9a-fA-F]{6}$/;

// トークンの値を文字列のまま返す。同じ変数が重ねて書かれていたら、CSS で効く後ろの値を返す。無ければ落とす
function readValue(block: string, theme: string, name: string): string {
  const values = [...block.matchAll(new RegExp(`--color-${name}:\\s*([^;]+);`, 'g'))];
  const value = values.at(-1)?.[1].trim();
  assert.ok(value, `${theme} に --color-${name} が見つからない`);
  return value;
}

// 6桁の hex だけを数にする。var() や color-mix() が来たら、計算できないので直し先を書いて落とす
function readColor(block: string, theme: string, name: string): string {
  const value = readValue(block, theme, name);
  assert.match(
    value,
    hex,
    `${theme} の --color-${name} が 6桁の hex でない（${value}）。段階の色と地の色は、テストが計算できるよう hex で書くか、このテスト（scripts/design-contrast.test.ts）に値の解き方を足す`,
  );
  return value.toLowerCase();
}

// WCAG 2 の相対輝度
function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(color.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('地の色', () => {
  test('シンプル（自動）の prefers-color-scheme の側は、simple_dark と同じ地の値', () => {
    const dark = blocks['シンプル（ダーク）'];
    for (const name of groundNames) {
      assert.equal(
        readValue(autoDarkBlock, 'シンプル（自動）のダークの側', name).toLowerCase(),
        readValue(dark, 'シンプル（ダーク）', name).toLowerCase(),
        `--color-${name} が simple_dark と食い違う`,
      );
    }
  });
});

describe('操作部品の枠の色のコントラスト', () => {
  const edgeMinimum = 3; // WCAG 2.2 の 1.4.11（UI の部品と背景）
  const all = { ...blocks, 'シンプル（自動）のダークの側': autoDarkBlock };

  for (const [theme, block] of Object.entries(all)) {
    test(`${theme}: --color-control-edge と地（bg、surface）が ${edgeMinimum}:1 以上`, () => {
      const edge = readColor(block, theme, 'control-edge');
      const failures = (['bg', 'surface'] as const)
        .map((ground) => [ground, contrast(edge, readColor(block, theme, ground))] as const)
        .filter(([, ratio]) => ratio < edgeMinimum)
        .map(
          ([ground, ratio]) =>
            `${theme} の --color-control-edge（${edge}）と --color-${ground} は ${ratio.toFixed(2)}:1`,
        );
      assert.deepEqual(failures, [], `${edgeMinimum}:1 を割る組がある`);
    });
  }

  test('シンプル（自動）のダークの側は、simple_dark と同じ値', () => {
    assert.equal(
      readValue(autoDarkBlock, 'シンプル（自動）のダークの側', 'control-edge').toLowerCase(),
      readValue(blocks['シンプル（ダーク）'], 'シンプル（ダーク）', 'control-edge').toLowerCase(),
    );
  });

  test('操作部品の基本の規則は、枠に --color-control-edge を使う', () => {
    const selectors = ['.btn', '.pill', '.search', '.nav-search', '.org-menu-button', '.input, .select, .textarea'];
    for (const selector of selectors) {
      const rule = [...components.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, s]) => s.trim() === selector);
      assert.ok(rule, `design/components.css に ${selector} の規則が見つからない`);
      assert.match(
        rule[2],
        /border:\s*1px solid var\(--color-control-edge\)/,
        `${selector} の枠が --color-control-edge でない`,
      );
    }
  });
});

describe('お気に入りの星の色', () => {
  const all = { ...blocks, 'シンプル（自動）のダークの側': autoDarkBlock };
  for (const [theme, block] of Object.entries(all)) {
    test(`${theme}: お気に入りの金と地5色が3:1以上`, () => {
      const color = readColor(block, theme, 'favorite');
      for (const ground of groundNames) {
        const ratio = contrast(color, readColor(block, theme, ground));
        assert.ok(ratio >= 3, `${theme} の星（${color}）と --color-${ground} は ${ratio.toFixed(2)}:1`);
      }
    });
  }

  test('シンプル（自動）のダークの側は、simple_dark と同じお気に入りの色', () => {
    assert.equal(
      readColor(autoDarkBlock, 'シンプル（自動）のダークの側', 'favorite'),
      readColor(blocks['シンプル（ダーク）'], 'シンプル（ダーク）', 'favorite'),
    );
  });

  test('塗った星は --color-favorite を color に使う', () => {
    const rules = [...components.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selector]) => selector.trim() === '.favorite-mark[aria-pressed="true"]',
    );
    assert.equal(rules.length, 1);
    const colors = [...rules[0][2].matchAll(/(?:^|[;\s])color:\s*([^;]+?)\s*(?:;|$)/g)].map(([, value]) => value);
    assert.deepEqual(colors, ['var(--color-favorite)']);
  });
});
