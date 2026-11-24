import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import AppShell from './AppShell.svelte';
import LazyCreateSheet from './LazyCreateSheet.svelte';
import { navigationLoading } from '../navigation-loading.svelte.ts';

vi.mock('$app/state', () => ({
  page: { data: { organization: { organization: { name: '架空の組織', kind: 'team' } } } },
}));
vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  beforeNavigate: vi.fn(),
  afterNavigate: vi.fn(),
  onNavigate: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('$app/paths', () => ({
  asset: (path: string) => `/${path}`,
  resolve: (route: string, params: { slug: string; id?: string }) =>
    route.replace('[slug]', params.slug).replace('[id]', params.id ?? ''),
}));

// 通知の確認に使うフォーカス先を、普段のマウス操作でも受ける要素に変えない。
test('本文の main は初期状態では tabindex を持たない', () => {
  const body = render(AppShell, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: false,
      isAdmin: false,
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body;
  const main = body.match(/<main\b[^>]*>/)?.[0];
  expect(main).toContain('id="content"');
  expect(main).not.toContain('tabindex');
});

const shell = (current: string, workspace?: { id: string; name: string; role: 'leader' | 'member' }) =>
  render(AppShell, {
    props: {
      current,
      slug: 'aoba',
      hasWorkspace: true,
      isAdmin: false,
      workspace,
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body;

test('パンくずは上の帯ではなく、本文の直前の帯（.sheet-crumbs）に置く', () => {
  const body = shell('/aoba/w/w1/board', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const topbar = body.match(/<div class="topbar">[\s\S]*?(?=<div class="sheet-crumbs">)/)?.[0] ?? '';
  expect(topbar).not.toContain('class="breadcrumb"');
  expect(body.replace(/<!--[^>]*-->/g, '')).toMatch(
    /<div class="sheet-crumbs"><nav class="breadcrumb"[\s\S]*?<\/nav><\/div>\s*<main\b/,
  );
});

test('組織の画面のパンくずは組織と画面だけで、ワークスペースを出さない', () => {
  const body = shell('/aoba', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav).toContain('aria-label="パンくず"');
  expect(nav).toContain('架空の組織');
  expect(nav).toContain('今日やること');
  expect(nav).not.toContain('ふくろう班');
  expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
});

test('ワークスペースの画面のパンくずは組織、ワークスペース、画面の順で、今の画面だけが aria-current', () => {
  const body = shell('/aoba/w/w1/board', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav.indexOf('架空の組織')).toBeLessThan(nav.indexOf('ふくろう班'));
  expect(nav.indexOf('ふくろう班')).toBeLessThan(nav.indexOf('ボード'));
  expect(nav).toContain('href="/aoba/w/w1"');
  expect(nav).toMatch(/<span[^>]*aria-current="page"[^>]*>ボード<\/span>/);
});

test('画面の名前が決まらない画面では、最後の項目を今の画面にし、戻れるようリンクは残す', () => {
  const body = shell('/aoba/w/w1/tasks/t1', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav).toMatch(/<a[^>]*aria-current="page"[^>]*>ふくろう班<\/a>/);
  expect(nav).toContain('href="/aoba/w/w1"');
});

test('Wiki の下の階層でも Wiki を今の画面にし、メニューに無い画面はアカウントの画面の名前を引く', () => {
  expect(shell('/aoba/w/w1/wiki/page-1', { id: 'w1', name: 'ふくろう班', role: 'member' })).toMatch(
    /<span[^>]*aria-current="page"[^>]*>Wiki<\/span>/,
  );
  expect(shell('/aoba/me')).toMatch(/<span[^>]*aria-current="page"[^>]*>マイプロフィール<\/span>/);
});

test('URL のワークスペースとメニューの対象が食い違うときは、対象の名前をパンくずに出さない', () => {
  const body = shell('/aoba/w/w2/board', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav).not.toContain('ふくろう班');
});

test('上の帯に検索の欄があり、ワークスペースの画面ではバックログの検索の行き先を持つ', () => {
  const body = render(AppShell, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: false,
      isAdmin: false,
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body;
  expect(body).toMatch(/<input[^>]*role="combobox"[^>]*aria-label="画面とタスクを探す"/);
  expect(body).toContain('aria-keyshortcuts="Control+K Meta+K"');
});

test('枠の中の遅い移動だけ本文をbusyにし、操作を止めない', () => {
  try {
    for (const kind of [null, 'outside', 'inside'] as const) {
      navigationLoading.kind = kind;
      const body = shell('/aoba');
      const main = body.match(/<main\b[^>]*>/)?.[0] ?? '';
      expect(main.includes('aria-busy="true"')).toBe(kind === 'inside');
      expect(main).not.toContain('inert');
      expect(main).not.toContain('aria-hidden');
    }
  } finally {
    navigationLoading.kind = null;
  }
});

test('起票する前はシートも、ほかの画面の本文欄や属性メニューと重なる要素も描かない', () => {
  const body = shell('/aoba/w/w1', { id: 'w1', name: '架空のワークスペース', role: 'member' });
  expect(body).not.toContain('class="create-sheet"');
  expect(body).not.toContain('create-sheet-title');
  expect(body).not.toContain('class="markdown-editor"');
  expect(body).not.toContain('class="row-menu"');
});

test('起票のコードを読む前も、ボタンのaria-controlsが指すidを描く', () => {
  const body = render(LazyCreateSheet, { props: { slug: 'aoba', workspaceId: 'w1', id: 'create-target' } }).body;
  expect(body.match(/id="create-target"/g)).toHaveLength(1);
  expect(body).not.toContain('<dialog');
});

test('組織の切り替えは上の帯のアシスタントとアカウントの間に置く（#1510）', () => {
  const body = render(AppShell, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: false,
      isAdmin: false,
      assistant: createRawSnippet(() => ({ render: () => '<button class="assist-launch">架空の頼む</button>' })),
      organizationSwitcher: createRawSnippet(() => ({ render: () => '<div class="org-menu">架空の組織</div>' })),
      account: createRawSnippet(() => ({ render: () => '<div class="account-menu">架空の人</div>' })),
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body.replace(/<!--[^>]*-->/g, '');
  const topbar = body.match(/<div class="topbar">[\s\S]*?(?=<aside class="binding")/)?.[0] ?? '';
  expect(topbar).toMatch(/assist-launch[\s\S]*class="org-menu"[\s\S]*class="account-menu"/);
  const binding = body.match(/<aside class="binding"[\s\S]*?<\/aside>/)?.[0] ?? '';
  expect(binding).not.toContain('org-menu');
});

// 上の帯は全幅で .app の先頭に置き、左端に開閉のボタン、マークの順で並べる。左のメニューと本文はその後に続く（#1511）
test('上の帯は枠の先頭にあり、左端に開閉のボタンとマークを並べ、左のメニューに角のマスを持たない（#1511）', () => {
  const body = render(AppShell, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: false,
      isAdmin: false,
      account: createRawSnippet(() => ({ render: () => '<div class="account-menu">架空の人</div>' })),
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body.replace(/<!--[^>]*-->/g, '');
  expect(body).toMatch(/<div class="app"[^>]*>\s*<div class="topbar">\s*<div class="topbar-start">/);
  const start = body.match(/<div class="topbar-start">[\s\S]*?<\/a>\s*<\/div>/)?.[0] ?? '';
  expect(start).toMatch(/class="nav-toggle"[\s\S]*class="brand" href="\/aoba"/);
  expect(start).toContain('aria-controls="app-nav"');
  expect(start).toContain('aria-expanded="true"');
  expect(body.indexOf('class="topbar"')).toBeLessThan(body.indexOf('class="binding"'));
  expect(body.indexOf('class="binding"')).toBeLessThan(body.indexOf('class="sheet"'));
  expect(body).not.toContain('binding-head');
});

// 左のメニューの右の境目（#1513）。綴じの中、.binding-inner の後に置き（overflow-x: hidden で切れないため）、
// 読み上げの名前と今の幅、範囲を持つ separator にする。札は見せるだけで、読み上げは aria の値が受け持つ
test('左のメニューの右の境目は、幅の値と範囲を持つ separator として綴じの中身の後に置く（#1513）', () => {
  const body = render(AppShell, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: false,
      isAdmin: false,
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body.replace(/<!--[^>]*-->/g, '');
  const binding = body.match(/<aside class="binding"[\s\S]*?<\/aside>/)?.[0] ?? '';
  expect(binding).toMatch(
    /<\/div>\s*<\/div>\s*<div class="nav-resize"[^>]*>\s*<span class="nav-resize-tip" aria-hidden="true">ダブルクリックで閉じる<\/span>\s*<\/div>\s*<\/aside>$/,
  );
  const handle = binding.match(/<div class="nav-resize"[^>]*>/)?.[0] ?? '';
  expect(handle).toContain('role="separator"');
  expect(handle).toContain('tabindex="0"');
  expect(handle).toContain('aria-orientation="vertical"');
  expect(handle).toContain('aria-label="メニューの幅"');
  expect(handle).toContain('aria-controls="app-nav"');
  expect(handle).toContain('aria-valuenow="240"');
  expect(handle).toContain('aria-valuemin="200"');
  expect(handle).toContain('aria-valuemax="480"');
  expect(body).toMatch(/<div class="app"[^>]*--nav-width: 240px/);
});
