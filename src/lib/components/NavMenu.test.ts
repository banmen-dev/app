import { render } from 'svelte/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import NavMenu from './NavMenu.svelte';
import type { Favorite } from '../favorites.svelte.ts';
import { navWorkspacesState } from '../nav-collapse.svelte.ts';

const { organization, favoriteState } = vi.hoisted(() => ({
  favoriteState: {
    current: undefined as
      { available: boolean; items: Favorite[]; loadFailed?: boolean; loading?: boolean } | undefined,
  },
  organization: { name: '架空の組織', kind: 'team' as 'team' | 'personal' },
}));

vi.mock('../favorites.svelte.ts', () => ({ useFavorites: () => favoriteState.current }));

vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));

vi.mock('$app/state', () => ({ page: { data: { organization: { organization } } } }));

beforeEach(() => {
  organization.kind = 'team';
  favoriteState.current = undefined;
  navWorkspacesState.collapsed = false;
});

vi.mock('$app/paths', () => ({
  resolve: (route: string, params: { slug: string; id?: string }) =>
    route.replace('[slug]', params.slug).replace('[id]', params.id ?? ''),
}));

const workspace = { id: 'one', name: '架空の開発チーム', role: 'member' as const };
const workspaces = [
  { id: 'one', name: '架空の開発チーム' },
  { id: 'two', name: '架空の保守チーム' },
];

test('今日やることでも対象のリンクがあり、現在地は今日やることだけ', () => {
  const body = render(NavMenu, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: true,
      isAdmin: false,
      workspace,
      workspaces,
      inWorkspaceScreen: false,
    },
  }).body;
  expect(body).toContain('href="/aoba/w/two"');
  expect(body).toContain('href="/aoba/w/one"');
  expect(body.match(/aria-current="page"/g)).toHaveLength(1);
  expect(body).toMatch(/href="\/aoba"[^>]*aria-current="page"/);
});

test('ワークスペースの機能の項目と「管理」の見出しは、ロールによらず出さない（タブで移る）', () => {
  for (const role of ['leader', 'member'] as const) {
    for (const isAdmin of [false, true]) {
      const body = render(NavMenu, {
        props: {
          current: '/aoba/w/one',
          slug: 'aoba',
          hasWorkspace: true,
          isAdmin,
          workspace: { ...workspace, role },
          workspaces,
          inWorkspaceScreen: true,
        },
      }).body;
      for (const path of ['/board', '/plan', '/wiki', '/members', '/settings', '/connections']) {
        expect(body).not.toContain(`href="/aoba/w/one${path}"`);
      }
      expect(body).not.toContain('nav-go-backlog');
    }
  }
});

test('対象が無いときも今日やることと組織の Wiki を出す', () => {
  const body = render(NavMenu, {
    props: { current: '/aoba', slug: 'aoba', hasWorkspace: false, isAdmin: true, inWorkspaceScreen: true },
  }).body;
  expect(body).not.toContain('/w/');
  expect(body).toContain('href="/aoba/wiki"');
  expect(body).toContain('架空の組織の Wiki');
});

test.each([
  ['team', '架空の組織の Wiki'],
  ['personal', '自分用の Wiki'],
] as const)('組織の Wiki（%s）の現在地と名前を保ち、対象のワークスペースもメニューに残す', (kind, label) => {
  organization.kind = kind;
  const body = render(NavMenu, {
    props: {
      current: '/aoba/wiki/page',
      slug: 'aoba',
      hasWorkspace: true,
      isAdmin: false,
      workspace,
      workspaces,
      inWorkspaceScreen: false,
    },
  }).body;
  expect(body).toContain(label);
  expect(body).toMatch(/class="nav-item is-wrapping"[^>]*href="\/aoba\/wiki"[^>]*aria-current="page"/);
  expect(body).toContain('href="/aoba/w/two"');
  expect(body.match(/aria-current="page"/g)).toHaveLength(1);
});

test('お気に入りは組織とワークスペースの節の間に、種類・題・全文title付きで出す', () => {
  favoriteState.current = {
    available: true,
    items: [
      {
        id: 'mark',
        target_type: 'story',
        target_id: 'story-one',
        workspace_id: 'one',
        title: '架空のストーリー',
        created_at: '',
      },
    ],
  };
  const body = render(NavMenu, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: true,
      isAdmin: false,
      workspace,
      workspaces,
      inWorkspaceScreen: false,
    },
  }).body;
  expect(body).toContain('href="/aoba/w/one?story=story-one"');
  expect(body).toContain('title="架空のストーリー"');
  expect(body.indexOf('nav-favorites')).toBeGreaterThan(body.indexOf('href="/aoba/wiki"'));
  expect(body.indexOf('nav-favorites')).toBeLessThan(body.indexOf('href="/aoba/w/two"'));
});

test('0件は節を出さず、一覧失敗は0件と分けて説明と再試行を出す', () => {
  const props = { current: '/aoba', slug: 'aoba', hasWorkspace: false, isAdmin: false, inWorkspaceScreen: true };
  favoriteState.current = { available: true, items: [] };
  expect(render(NavMenu, { props }).body).not.toContain('nav-favorites');
  favoriteState.current = { available: false, items: [] };
  const body = render(NavMenu, { props }).body;
  expect(body).toContain('お気に入りを読み込めませんでした。');
  expect(body).toContain('もう一度試す');
});

test('リンクにできる対象が無い一覧では見出しだけの節を出さない', () => {
  favoriteState.current = {
    available: true,
    items: [
      { id: 'bad', target_type: 'task', target_id: 'task', workspace_id: null, title: '架空の題', created_at: '' },
    ],
  };
  const body = render(NavMenu, {
    props: { current: '/aoba', slug: 'aoba', hasWorkspace: false, isAdmin: false, inWorkspaceScreen: true },
  }).body;
  expect(body).not.toContain('nav-favorites');
});

test('手動の再試行が続く間は0件へ更新されても操作の節を外さない', () => {
  favoriteState.current = { available: true, items: [], loadFailed: false, loading: true };
  const body = render(NavMenu, {
    props: { current: '/aoba', slug: 'aoba', hasWorkspace: false, isAdmin: false, inWorkspaceScreen: true },
  }).body;
  expect(body).toContain('nav-favorites');
  expect(body).toContain('もう一度試す');
  expect(body).toContain('読み込んでいます');
});

describe('ワークスペースの一覧', () => {
  const props = {
    current: '/aoba/w/one',
    slug: 'aoba',
    hasWorkspace: true,
    isAdmin: false,
    workspace,
    workspaces,
    inWorkspaceScreen: true,
  };

  test('見出しは開閉のボタンで、一覧を所属の順に並べ、今のものにチェックと現在地を付ける', () => {
    const body = render(NavMenu, { props: props }).body;
    expect(body).toMatch(
      /<button[^>]*class="nav-group-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="app-nav-workspaces"/,
    );
    expect(body).toContain('aria-label="ワークスペースの一覧を開閉"');
    expect(body).not.toMatch(/<ul[^>]*\shidden/);
    expect(body.indexOf('href="/aoba/w/one"')).toBeLessThan(body.indexOf('href="/aoba/w/two"'));
    expect(body).toMatch(/href="\/aoba\/w\/one"[^>]*aria-current="page"/);
    expect(body).not.toMatch(/href="\/aoba\/w\/two"[^>]*aria-current/);
    expect(body).toContain('title="架空の保守チーム"');
  });

  test('畳んだ状態は一覧を隠し、aria-expanded を偽にする', () => {
    navWorkspacesState.collapsed = true;
    const body = render(NavMenu, { props: props }).body;
    expect(body).toMatch(/aria-expanded="false"/);
    expect(body).toMatch(/<ul[^>]*id="app-nav-workspaces"[^>]*hidden/);
  });

  test('今日やることの画面では、対象の行にチェックだけを付け、現在地にはしない', () => {
    const body = render(NavMenu, {
      props: { ...props, current: '/aoba', inWorkspaceScreen: false },
    }).body;
    expect(body).not.toMatch(/href="\/aoba\/w\/one"[^>]*aria-current/);
    expect(body).toContain('href="#i-check"');
  });

  test('所属していない管理者が開いているものは、押せない行で先頭に出し、移動先に加えない', () => {
    const body = render(NavMenu, {
      props: {
        ...props,
        isAdmin: true,
        workspace: { id: 'other', name: '架空の管理対象チーム', role: null },
      },
    }).body;
    expect(body).toMatch(/<span[^>]*aria-current="page"[^>]*>[\s\S]*架空の管理対象チーム/);
    expect(body).not.toContain('href="/aoba/w/other"');
    expect(body.indexOf('架空の管理対象チーム')).toBeLessThan(body.indexOf('href="/aoba/w/one"'));
  });

  test('タスクの詳細のような画面でも、対象の行が現在地を伝える', () => {
    const body = render(NavMenu, { props: { ...props, current: '/aoba/w/one/tasks/xxx' } }).body;
    const list = body.match(/<ul[\s\S]*?<\/ul>/)![0];
    expect(list).toMatch(/href="\/aoba\/w\/one"[^>]*aria-current="page"/);
    expect(list).not.toContain('（開いている）');
  });

  test('対象が無い人（所属が無い）には見出しも一覧も出さない', () => {
    const body = render(NavMenu, {
      props: {
        current: '/aoba',
        slug: 'aoba',
        hasWorkspace: false,
        isAdmin: false,
        inWorkspaceScreen: true,
        workspaces: [],
      },
    }).body;
    expect(body).not.toContain('nav-group-toggle');
    expect(body).not.toContain('app-nav-workspaces');
  });
});
