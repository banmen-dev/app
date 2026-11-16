import type { OutputOf } from '../shared/operations/define.ts';
import type { myWorkspaces } from '../shared/operations/organization/my-workspaces.ts';

export type MyWorkspacesView = OutputOf<typeof myWorkspaces>;
export type OrganizationWorkspaces = MyWorkspacesView['organizations'][number];

// 全組織のダッシュボード（/）の、1つの組織のまとまりに出すワークスペースの状態。
//   loading: my-workspaces をまだ読んでいる（undefined）
//   unavailable: my-workspaces 全体が一度も読めていない（null）。案内は面の先頭の1か所にだけ出し、組織ごとには出さない
//   failed: その組織が読めなかった組織に入っている
//   omitted: 読めたが、その組織は読む組織の上限（10）の外か、読んだ後に入れるようになった（答えに無い）
//   ready: その組織の、自分が所属する閉じていないワークスペース（空もある）
export type DashboardWorkspaces =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'failed' }
  | { kind: 'omitted' }
  | { kind: 'ready'; entry: OrganizationWorkspaces };

export function dashboardWorkspacesOf(view: MyWorkspacesView | null | undefined, slug: string): DashboardWorkspaces {
  if (view === undefined) return { kind: 'loading' };
  if (view === null) return { kind: 'unavailable' };
  const entry = view.organizations.find((organization) => organization.organization.slug === slug);
  if (entry !== undefined) return { kind: 'ready', entry };
  if (view.failed_organizations.some((organization) => organization.slug === slug)) return { kind: 'failed' };
  return { kind: 'omitted' };
}
