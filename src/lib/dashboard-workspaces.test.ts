import { describe, expect, test } from 'vitest';
import { dashboardWorkspacesOf, type MyWorkspacesView } from './dashboard-workspaces.ts';

const team = { slug: 'aoba', name: '青葉工房', kind: 'team' as const };
const broken = { slug: 'kaede', name: '楓工房', kind: 'team' as const };
const view: MyWorkspacesView = {
  organizations: [{ organization: team, me_id: 'u1', workspaces: [{ id: 'w1', name: '受付の班', role: 'leader' }] }],
  omitted_organizations: 1,
  failed_organizations: [broken],
};

describe('dashboardWorkspacesOf', () => {
  test('読んでいる間、全体の失敗、組織の失敗、読まなかった組織、読めた組織を分ける', () => {
    expect(dashboardWorkspacesOf(undefined, 'aoba')).toEqual({ kind: 'loading' });
    expect(dashboardWorkspacesOf(null, 'aoba')).toEqual({ kind: 'unavailable' });
    expect(dashboardWorkspacesOf(view, 'kaede')).toEqual({ kind: 'failed' });
    expect(dashboardWorkspacesOf(view, 'sakura')).toEqual({ kind: 'omitted' });
    expect(dashboardWorkspacesOf(view, 'aoba')).toEqual({ kind: 'ready', entry: view.organizations[0] });
    // 読み直している間は、答えに無い組織を読み込み中にする（読めた組織と読めなかった組織はそのまま）
    expect(dashboardWorkspacesOf(view, 'sakura', true)).toEqual({ kind: 'loading' });
    expect(dashboardWorkspacesOf(view, 'aoba', true)).toEqual({ kind: 'ready', entry: view.organizations[0] });
    expect(dashboardWorkspacesOf(view, 'kaede', true)).toEqual({ kind: 'failed' });
  });
});
