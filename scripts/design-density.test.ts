// 広い幅でマウスなどだけで操作する画面の詰め（#828。docs/design.md の「どのテーマにも共通すること」の「密度」）。
// タッチの画面を持つ PC（主な入力は pointer: fine、ほかに any-pointer: coarse）は、押せる範囲 44px のための余白を残して詰めない。
// この組み合わせは Playwright でもブラウザの開発者ツールのプロトコルでもまねられず、e2e では確かめられないので、
// 詰めの規則を置いた @media の条件を components.css から読んで確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readCss(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

const components = readCss('../design/components.css');
const boot = readCss('../static/boot-loading.css');
const wide = 'not (max-width: 760px)';
const mouseOnly = '(pointer: fine) and (not (any-pointer: coarse))';

// 開き括弧の後ろから、対応する閉じ括弧までの中身を返す
function bodyAfter(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(openIndex + 1, i);
  }
  throw new Error('CSS の波括弧が閉じていない');
}

function mediaBlocks(source: string) {
  const blocks = [];
  let depth = 0;
  for (const match of source.matchAll(/@media\s+([^{}]+)\{|[{}]/g)) {
    if (match[0] === '}') {
      depth--;
      continue;
    }
    if (match[1]) {
      const open = match.index + match[0].length - 1;
      const body = bodyAfter(source, open);
      blocks.push({ condition: match[1].trim(), body, depth, start: match.index, end: open + body.length + 2 });
    }
    depth++;
  }
  return blocks;
}

function mediaBody(source: string, condition: string): string {
  return mediaBlocks(source)
    .filter((block) => block.depth === 0 && block.condition === condition)
    .map((block) => block.body)
    .join('\n');
}

function withoutNestedMedia(source: string): string {
  // 外側の @media の直下に置く規則を、追加のメディア条件の内側で拾わない
  for (const { start, end } of mediaBlocks(source)
    .filter(({ depth }) => depth === 0)
    .reverse()) {
    source = source.slice(0, start) + source.slice(end);
  }
  return source;
}

const fineBlocks = mediaBlocks(components).filter(({ condition }) => /\(pointer:\s*fine\)/.test(condition));
const wideComponents = mediaBody(components, wide);
const wideBoot = mediaBody(boot, wide);
const wideComponentRules = withoutNestedMedia(wideComponents);

test('枠と初回読み込みの CSS は AppShell の 760px の境に隙間を作らない', () => {
  const shell = readFileSync(new URL('../src/lib/components/AppShell.svelte', import.meta.url), 'utf8');
  assert.match(shell, /new MediaQuery\('\(max-width: 760px\)'\)/);
  for (const source of [components, boot]) {
    const oldConditions = mediaBlocks(source).filter(({ condition }) => /\(min-width:\s*761px\)/.test(condition));
    assert.deepEqual(
      oldConditions.map(({ condition }) => condition),
      [],
    );
  }
});

test('広い枠の綴じ、上の帯、ダッシュボード、ナビゲーションを狭い幅の補集合に置く', () => {
  assert.match(wideComponentRules, /html\s*\{\s*scroll-padding-top: var\(--header-height\);/);
  assert.match(wideComponentRules, /\.binding\s*\{[^}]*z-index: 5;/);
  assert.match(wideComponentRules, /\.nav-tip\s*\{[^}]*position: absolute;/);
  assert.match(wideComponentRules, /\.nav-toggle:focus-visible \.nav-tip\s*\{\s*display: grid;/);
  assert.match(mediaBody(wideComponents, '(hover: hover)'), /\.nav-toggle:hover \.nav-tip\s*\{\s*display: grid;/);
  assert.match(wideComponentRules, /\.topbar\s*\{\s*flex-wrap: nowrap;/);
  assert.match(
    mediaBody(wideComponents, '(max-width: 1439px)'),
    /\.topbar-tools \[data-switch\] > span[^{]*\{[^}]*clip:/,
  );
  assert.match(wideComponentRules, /\.dashboard\s*\{\s*grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/);
  assert.match(wideComponentRules, /\.mobile-navigation,\s*\.mobile-menu\s*\{\s*display: none;/);
  assert.match(
    mediaBody(wideComponents, '(pointer: coarse)'),
    /@container book[^{]*\{\s*\.entry\s*\{[^}]*minmax\(12rem,/,
  );
  assert.match(
    mediaBody(wideComponents, '(pointer: coarse)'),
    /@container tree[^{]*\{\s*\.entry\s*\{[^}]*minmax\(12rem,/,
  );
});

test('閉じた綴じと空の列を狭い幅の補集合で隠す', () => {
  const frame = wideComponentRules.match(/\.app\[data-nav-collapsed="true"\]\s*\{([^}]*)\}/);
  assert.ok(frame, '閉じた枠の規則が @media not (max-width: 760px) の中に無い');
  assert.match(frame[1], /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(frame[1], /grid-template-areas: "bar" "sheet";/);
  assert.match(wideComponentRules, /\.app\[data-nav-collapsed="true"\] > \.binding\s*\{\s*display: none;/);
});

test('綴じの境目の表示も狭い幅の補集合に揃える', () => {
  const hover = mediaBody(wideComponents, '(hover: hover)');
  assert.match(withoutNestedMedia(hover), /\.nav-resize\s*\{\s*display: block;/);
  assert.match(mediaBody(hover, '(forced-colors: active)'), /\.nav-resize-tip\s*\{\s*border-color: CanvasText;/);
});

test('初回読み込みの2列とマウス用の余白を狭い幅の補集合に置く', () => {
  assert.match(
    withoutNestedMedia(wideBoot),
    /#boot-loading \.boot-dashboard\s*\{\s*grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/,
  );
  const compactBoot = mediaBody(wideBoot, mouseOnly);
  assert.match(compactBoot, /#boot-loading \.boot-content\s*\{\s*gap: 24px;/);
  assert.match(compactBoot, /#boot-loading \.boot-head\s*\{\s*padding-bottom: 16px;/);
});

test('pointer: fine を条件にする @media は、どれもタッチの画面を持つ端末（any-pointer: coarse）を外す', () => {
  assert.ok(fineBlocks.length > 0, 'design/components.css に pointer: fine を条件にする @media が無い');
  for (const { condition } of fineBlocks) {
    assert.match(
      condition,
      /not \(any-pointer:\s*coarse\)/,
      `@media ${condition} は any-pointer: coarse の端末も詰める。タッチの画面を持つ PC で押せる範囲が狭くなる`,
    );
  }
});

test('行の詰め（台帳の行の min-height: 48px）は、760px を超えるタッチの無い画面だけに効く @media の中にある', () => {
  const dense = fineBlocks.filter(({ body }) => /\.entry\s*\{[^}]*min-height:\s*48px/.test(body));
  assert.equal(dense.length, 1, '台帳の行を詰める規則を置いた @media が1つでない');
  assert.ok(mediaBody(wideComponents, mouseOnly).includes(dense[0].body));
  assert.doesNotMatch(
    components.replace(dense[0].body, ''),
    /\.entry\s*\{[^}]*min-height:\s*48px/,
    '台帳の行を詰める規則が、その @media の外にもある',
  );
});

test('ナビゲーションは既定8px、マウスだけの広い画面では4pxに詰める', () => {
  const base = /(?:^|\n)\.nav-item\s*\{([^}]+)\}/.exec(components)?.[1];
  assert.ok(base, 'ナビゲーションの既定の規則が無い');
  assert.match(base, /padding:\s*var\(--space-2\)(?:\s+var\(--space-2\))?\s*;/);
  const dense = fineBlocks.filter(({ body }) => /\.nav-item\s*\{[^}]*padding-block:\s*var\(--space-1\)/.test(body));
  assert.equal(dense.length, 1);
  assert.ok(mediaBody(wideComponents, mouseOnly).includes(dense[0].body));
});
