import type { z } from 'zod';
import { myWorkspaces } from '../../shared/operations/organization/my-workspaces.ts';
import type { OrganizationDb } from '../db/index.ts';
import type { AccountOrganizationReader } from './account.ts';
import { implement } from './implement.ts';

type MyWorkspacesView = z.output<typeof myWorkspaces.output>;
type OrganizationWorkspaces = MyWorkspacesView['organizations'][number];

// 1つの組織の、自分が今所属する閉じていないワークスペース（名前の順、同名は ID の順）。組織のホームの organization が返す所属と同じ条件で、
// 閉じたものは読まない。管理者でも、所属していないワークスペースは読まない
export async function readMyWorkspaces(
  db: OrganizationDb,
  userId: string,
): Promise<Omit<OrganizationWorkspaces, 'organization'>> {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['w.id', 'w.name', 'm.role'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .orderBy('w.name')
        .orderBy('w.id'),
    ),
  );
  return {
    me_id: userId,
    workspaces: rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role === 'leader' ? ('leader' as const) : ('member' as const),
    })),
  };
}

// 組織をまたぐのは、渡された読み取り（cross-organization.ts の readAccountTaskOrganizations）だけ
export async function readAccountWorkspaces(read: AccountOrganizationReader): Promise<MyWorkspacesView> {
  const result = await read(readMyWorkspaces);
  return {
    organizations: result.organizations.map(({ organization, data }) => ({ organization, ...data })),
    omitted_organizations: result.omitted_organizations,
    failed_organizations: result.failed_organizations,
  };
}

export const myWorkspacesOperation = implement(myWorkspaces, async ({ account }) => account.workspaces());
