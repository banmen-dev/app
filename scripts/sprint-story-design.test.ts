// カタログのカード/ボードが、実際に強調状態を描画できることを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../design/kit.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('kit.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions: string[] = [];
function visit(node: ts.Node): void {
  if (
    ts.isFunctionDeclaration(node) &&
    ['storyFilterText', 'boardMatches', 'boardCategoryOf', 'boardToolbar', 'card', 'board'].includes(
      node.name?.text ?? '',
    )
  )
    functions.push(node.getText(ast));
  else ts.forEachChild(node, visit);
}
visit(ast);
const first = { id: 'a', title: 'ポイントを付ける', story: 'story', sprint: 'sprint', col: 'todo', pts: 3, who: 'u1' };
const second = { id: 'b', title: '文言を直す', story: null, sprint: 'sprint', col: 'todo', pts: 2, who: null };
const context = {
  boardCollapsed: new Map(),
  D: {
    stories: { story: { title: '同じストーリー', epic: null } },
    epics: {},
    categories: {},
    columns: [{ id: 'todo', name: '未着手', done: false }],
    definitionOfDone: '',
  },
  tasksWhere: (predicate: (task: typeof first | typeof second) => boolean) => [first, second].filter(predicate),
  sumPts: (items: { pts: number }[]) => items.reduce((sum, item) => sum + item.pts, 0),
  esc: (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
  draftRow: () => '<input class="input">',
  draftAttrs: () => '',
  t: (value: string) => value,
  icon: () => '',
  user: () => ({ name: '青木' }),
  popover: (text: string, body: string) => `<span class="popover">${text}${body}</span>`,
  dropAttr: () => '',
  titleOf: () => '',
  repoTag: () => '',
  sourceKey: () => '',
  taskFlags: () => '',
  taskDue: () => '',
  pts: () => '',
  avatarOf: () => '',
  doneControl: () => '',
  attrChip: () => '',
  cardEdit: () => '',
  rowMenu: () => '',
  orderItems: () => [],
};
const render = vm.runInNewContext(`${functions.join('\n')}; ({card, board, boardToolbar})`, context) as {
  card: (task: unknown, order: unknown, opts: unknown) => string;
  board: (id: string, opts?: unknown) => string;
  boardToolbar: (id: string, opts?: unknown) => string;
};
test('カードの親ボタンと、同じ親/別の親の強調状態を描く', () => {
  assert.match(render.card(first, undefined, { highlightStory: 'story' }), /is-story-highlighted/);
  assert.match(render.card(second, undefined, { highlightStory: 'story' }), /is-story-dimmed/);
  assert.match(render.card(first, undefined, {}), /data-story-filter="story"/);
});
test('ボードの絞り込みは道具の帯に条件と解除操作を持ち、件数とポイントも可視カードだけになる', () => {
  const toolbar = render.boardToolbar('sprint', { story: 'story' });
  assert.match(toolbar, /board-filter-summary/);
  assert.match(toolbar, /data-story-clear/);
  assert.match(toolbar, /2 件中 1 件を表示/);
  assert.doesNotMatch(render.boardToolbar('sprint'), /board-filter-summary|data-story-clear/);
  const html = render.board('sprint', { story: 'story' });
  assert.match(html, /board-col-n">1</);
  assert.match(html, /board-col-pts">3 pt</);
  assert.equal((html.match(/<article /g) ?? []).length, 1);
  assert.equal((render.board('sprint').match(/<article /g) ?? []).length, 2);
});

test('絞り込み後に列を畳んでも、件数とポイントと帯は保持する', () => {
  context.boardCollapsed.set('sprint-todo', true);
  try {
    const html = render.board('sprint', { story: 'story' });
    assert.match(html, /is-collapsed/);
    assert.match(html, /board-col-n">1</);
    assert.match(html, /board-col-pts">3 pt</);
    assert.equal((html.match(/<article /g) ?? []).length, 0);
  } finally {
    context.boardCollapsed.clear();
  }
});

test('見本の親IDと名前をescapeし、親付き起票の注記と帯の補足を描く', () => {
  const id = 'story"<&';
  const stories = context.D.stories as Record<string, { title: string }>;
  stories[id] = { title: '題"<&' };
  try {
    const card = render.card({ ...first, story: id }, undefined, {});
    assert.match(card, /data-story-filter="story&quot;&lt;&amp;"/);
    assert.match(card, /題&quot;&lt;&amp;/);
    const board = render.board('sprint', { story: 'story', draft: true });
    assert.match(board, /class="action-note"/);
    assert.match(board, /sprintStoryCreateUnder/);
    assert.match(render.boardToolbar('sprint', { story: 'story' }), /sprintStoryTotalsNote/);
  } finally {
    delete stories[id];
  }
});

test('担当と検索でも絞り、絞って空になった列は隠した件数を出す', () => {
  const byPerson = render.board('sprint', { assignees: ['none'] });
  assert.equal((byPerson.match(/<article /g) ?? []).length, 1);
  const bySearch = render.board('sprint', { q: '無い語' });
  assert.match(bySearch, /絞り込みで 2 件を隠しています/);
  const toolbar = render.boardToolbar('sprint', { assignees: ['u1'] });
  assert.match(toolbar, /aria-pressed="true"/);
  assert.match(toolbar, /aria-pressed="false"/);
});
