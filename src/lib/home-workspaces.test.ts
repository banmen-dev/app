import { describe, expect, test } from 'vitest';
import { homeEmptyKind, openWorkspaces } from './home-workspaces.ts';
import type { OrganizationView } from './organization.svelte.ts';

const open = { id: 'w-open', name: '架空の開発チーム', role: 'leader' as const, closed_at: null };
const closed = {
  id: 'w-closed',
  name: '架空の旧チーム',
  role: 'member' as const,
  closed_at: '2026-10-01T00:00:00.000Z',
};

function view(overrides: { is_admin: boolean; has_workspaces: boolean; workspaces: OrganizationView['workspaces'] }) {
  return {
    organization: { name: '架空の組織', kind: 'team', has_workspaces: overrides.has_workspaces },
    me: { id: 'u1', name: '架空の人', is_admin: overrides.is_admin, theme: 'simple', level: 1 },
    trial: null,
    storage: null,
    plan: null,
    workspaces: overrides.workspaces,
  } as OrganizationView;
}

describe('openWorkspaces', () => {
  test('閉じたワークスペースを外し、残りは返された順のまま', () => {
    const second = { ...open, id: 'w-second', name: '架空の二つ目', role: 'member' as const };
    expect(openWorkspaces([open, closed, second])).toEqual([open, second]);
  });

  test('closed_at が欠けた行（版のずれ）は閉じたものと見ず、残す', () => {
    const missing = { id: 'w-missing', name: '架空の欠けた行', role: 'member' } as unknown as typeof open;
    expect(openWorkspaces([missing, closed])).toEqual([missing]);
  });

  test('閉じたものだけなら空', () => {
    expect(openWorkspaces([closed])).toEqual([]);
  });
});

describe('homeEmptyKind', () => {
  test('ワークスペースが1つも無い管理者には、最初のワークスペースを作る案内', () => {
    expect(homeEmptyKind(view({ is_admin: true, has_workspaces: false, workspaces: [] }))).toBe('firstWorkspace');
  });

  test('管理者が閉じたワークスペースにだけ所属しているときは、所属が無い案内（作る案内ではない）', () => {
    expect(homeEmptyKind(view({ is_admin: true, has_workspaces: true, workspaces: [closed] }))).toBe('noMembership');
  });

  test('閉じていない所属があれば案内を出さない', () => {
    expect(homeEmptyKind(view({ is_admin: true, has_workspaces: true, workspaces: [closed, open] }))).toBe('default');
  });

  test('一般のメンバーが閉じたワークスペースにだけ所属しているときも default（案内は面の側が所属の無い案内にする。作る案内は管理者だけ）', () => {
    expect(homeEmptyKind(view({ is_admin: false, has_workspaces: true, workspaces: [closed] }))).toBe('default');
    expect(openWorkspaces([closed])).toEqual([]);
  });

  test('管理者でない人と、組織を読めないときは default', () => {
    expect(homeEmptyKind(view({ is_admin: false, has_workspaces: true, workspaces: [] }))).toBe('default');
    expect(homeEmptyKind(null)).toBe('default');
  });
});
