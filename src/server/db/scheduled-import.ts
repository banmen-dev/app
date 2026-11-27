import { syncConnection } from '../import/sync.ts';
import { commonDb, orgDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';

type ScheduledImportPosition = { id: string; last_success_at: string | null };
type ScheduledImportConnection = ScheduledImportPosition & { workspace_id: string };

// 定期処理が使える口を、接続の一覧とその同期に絞る。組織の入口を関数の外へ渡さない。
async function activeOrganizationDb(env: Env, organizationId: string) {
  const common = commonDb(env);
  const row = await common.first(
    common.statement((q) =>
      q.selectFrom('organizations').select('id').where('id', '=', organizationId).where('suspended_at', 'is', null),
    ),
  );
  return row && orgDb(env, issueVerifiedOrganization(row.id));
}

export async function readScheduledImportConnections(
  env: Env,
  organizationId: string,
  cycleStartedAt: string,
  after: ScheduledImportPosition | null,
  limit: number,
): Promise<ScheduledImportConnection[]> {
  const db = await activeOrganizationDb(env, organizationId);
  if (!db) return [];
  return db.rows(
    db.statement((q) => {
      let query = q
        .selectFrom('connections')
        .innerJoin('workspaces', 'workspaces.id', 'connections.workspace_id')
        .select(['connections.id', 'connections.workspace_id', 'connections.last_success_at'])
        .where('workspaces.organization_id', '=', db.organizationId)
        .where('workspaces.closed_at', 'is', null)
        .where('workspaces.deleted_at', 'is', null)
        .where('connections.status', 'in', ['active', 'error'])
        .where('connections.deleted_at', 'is', null)
        .where('connections.created_at', '<=', cycleStartedAt)
        .where((eb) =>
          eb.or([
            eb('connections.last_success_at', 'is', null),
            eb('connections.last_success_at', '<', cycleStartedAt),
          ]),
        );
      if (after !== null) {
        query = query.where((eb) =>
          eb.or([
            after.last_success_at === null
              ? eb('connections.last_success_at', 'is not', null)
              : eb('connections.last_success_at', '>', after.last_success_at),
            eb.and([
              eb('connections.last_success_at', 'is', after.last_success_at),
              eb('connections.id', '>', after.id),
            ]),
          ]),
        );
      }
      // SQLite の昇順では NULL が先頭に来る。
      return query.orderBy('connections.last_success_at').orderBy('connections.id').limit(limit);
    }),
  );
}

export async function syncScheduledImportConnection(
  env: Env,
  organizationId: string,
  connection: ScheduledImportConnection,
  deadline: number,
  fetcher: typeof fetch | undefined,
) {
  // 同じ回の接続一覧を読んだ後に組織が停止していないか、同期を始める直前にも確かめる。
  const db = await activeOrganizationDb(env, organizationId);
  if (!db) return 'organization_suspended';
  if (Date.now() >= deadline) return { outcome: 'budget_exhausted' } as const;
  return syncConnection(env, db, connection.workspace_id, connection.id, { fetcher, absoluteDeadline: deadline });
}
