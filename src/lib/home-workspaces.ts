import type { OrganizationView } from './organization.svelte.ts';

type Workspaces = OrganizationView['workspaces'];

// 組織のホームのワークスペースの面に並べるワークスペース。`organization` が返す所属のうち、閉じていないものだけ
// （閉じたものは `closed_at` が入る。左のメニューなど、ほかの使い手は閉じたものも並べる）。順は返された順（名前順）のまま
export function openWorkspaces(workspaces: Workspaces): Workspaces {
  // 閉じたと見るのは closed_at が文字列のときだけ。版のずれで項目が欠けた行（undefined）は閉じていないものとして残す
  return workspaces.filter((workspace) => typeof workspace.closed_at !== 'string');
}

export type HomeEmptyKind = 'default' | 'firstWorkspace' | 'noMembership';

// ワークスペースの面の空の案内。管理者に限り、組織にワークスペースが1つも無ければ最初のワークスペースを作る案内、
// 閉じていない所属が0件（閉じたワークスペースにだけ所属している場合を含む）なら所属が無い案内を出す。ほかは 'default'。
// `has_workspaces` は閉じたものを含むので、閉じたものしか無い組織で最初のワークスペースを作る案内は出さない
export function homeEmptyKind(view: OrganizationView | null): HomeEmptyKind {
  if (view === null || !view.me.is_admin) return 'default';
  if (!view.organization.has_workspaces) return 'firstWorkspace';
  return openWorkspaces(view.workspaces).length === 0 ? 'noMembership' : 'default';
}
