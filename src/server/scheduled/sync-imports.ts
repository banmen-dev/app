import { z } from 'zod';
import { commonDb, readScheduledImportConnections, syncScheduledImportConnection } from '../db/index.ts';

const CURSOR_KEY = 'system/sync-imports-cursor';
const MAX_ORGANIZATIONS = 50;
const MAX_CONNECTIONS = 10;
const TIME_BUDGET_MS = 60_000;

const cursorSchema = z.object({
  cycleStartedAt: z.iso.datetime(),
  organizationId: z.string().min(1).max(64),
  connection: z.object({ id: z.string().min(1).max(64), last_success_at: z.string().max(64).nullable() }).nullable(),
});
const storedCursorSchema = z.object({ position: cursorSchema.nullable() });

type Cursor = z.infer<typeof cursorSchema>;

function parseCursor(value: string, startedAt: string): Cursor | undefined {
  if (value === '') return undefined;
  try {
    const result = storedCursorSchema.safeParse(JSON.parse(value));
    const position = result.data?.position;
    if (position && position.cycleStartedAt <= startedAt) return position;
  } catch {
    // 進捗が壊れていたら先頭から巡り直す。
  }
}

export async function syncImports(
  env: Env,
  _scheduledTime: Date,
  options: { maxConnections?: number; timeBudgetMs?: number; fetcher?: typeof fetch } = {},
): Promise<void> {
  const { maxConnections = MAX_CONNECTIONS, timeBudgetMs = TIME_BUDGET_MS, fetcher } = options;
  if (
    !Number.isInteger(maxConnections) ||
    maxConnections < 1 ||
    maxConnections > MAX_CONNECTIONS ||
    !Number.isFinite(timeBudgetMs) ||
    timeBudgetMs < 0 ||
    timeBudgetMs > TIME_BUDGET_MS
  )
    throw new Error('取り込みの定期処理の予算が範囲外');

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const deadline = started + timeBudgetMs;
  let cursor: Cursor = { cycleStartedAt: startedAt, organizationId: '', connection: null };
  let visited = 0;
  let attempted = 0;
  let imported = 0;
  let complete = false;
  let cursorConflict = 0;
  const outcomes = { success: 0, continued: 0, auth_failed: 0, error: 0, not_found: 0, no_scope: 0, stopped: 0 };
  const failures = { cursor_read: 0, organization_list: 0, organization: 0, connection: 0, cursor_write: 0 };
  let stage: 'cursor_read' | 'organization_list' | 'cursor_write' = 'cursor_read';
  const hasBudget = () => attempted < maxConnections && Date.now() < deadline;

  try {
    const stored = await env.ATTACHMENTS.get(CURSOR_KEY);
    if (stored !== null && stored.size <= 512) cursor = parseCursor(await stored.text(), startedAt) ?? cursor;

    stage = 'organization_list';
    const common = commonDb(env);
    const organizations = await common.rows(
      common.statement((q) =>
        q
          .selectFrom('organizations')
          .select('id')
          .where('suspended_at', 'is', null)
          .where('created_at', '<=', cursor.cycleStartedAt)
          .where('id', cursor.connection === null ? '>' : '>=', cursor.organizationId)
          .orderBy('id')
          .limit(MAX_ORGANIZATIONS + 1),
      ),
    );

    scan: for (const { id } of organizations.slice(0, MAX_ORGANIZATIONS)) {
      if (!hasBudget()) break;
      let connections;
      try {
        connections = await readScheduledImportConnections(
          env,
          id,
          cursor.cycleStartedAt,
          id === cursor.organizationId ? cursor.connection : null,
          maxConnections - attempted + 1,
        );
      } catch {
        failures.organization++;
        cursor = { ...cursor, organizationId: id, connection: null };
        visited++;
        continue;
      }

      for (const connection of connections) {
        if (!hasBudget()) break scan;
        try {
          const result = await syncScheduledImportConnection(env, id, connection, deadline, fetcher);
          if (result.outcome === 'organization_suspended') break;
          if (result.outcome === 'budget_exhausted') break scan;
          outcomes[result.outcome]++;
          if (result.outcome === 'success' && result.more) outcomes.continued++;
          if ('imported' in result) imported += result.imported;
        } catch {
          failures.connection++;
        }
        attempted++;
        cursor = {
          ...cursor,
          organizationId: id,
          connection: { id: connection.id, last_success_at: connection.last_success_at },
        };
      }
      cursor = { ...cursor, organizationId: id, connection: null };
      visited++;
    }

    complete = visited === organizations.length;
    stage = 'cursor_write';
    // 並行した回が先に進捗を書いていたら、古い進捗で上書きしない。
    // 完走して位置を消すときも、保存ごとに内容を変えて ETag を更新する。
    const position = complete || cursor.organizationId === '' ? null : cursor;
    const updated = await env.ATTACHMENTS.put(CURSOR_KEY, JSON.stringify({ revision: crypto.randomUUID(), position }), {
      onlyIf: stored === null ? { etagDoesNotMatch: '*' } : { etagMatches: stored.etag },
    });
    if (updated === null) cursorConflict++;
  } catch {
    failures[stage]++;
  }

  const failed = Object.values(failures).some((count) => count > 0);
  const log = JSON.stringify({
    job: 'sync-imports',
    visited,
    attempted,
    imported,
    outcomes,
    failures,
    complete,
    cursorConflict,
  });
  if (failed) {
    console.error(log);
    throw new Error('取り込みの定期処理に失敗した');
  }
  if (!complete || cursorConflict > 0 || outcomes.error > 0 || outcomes.auth_failed > 0) console.warn(log);
  else console.info(log);
}
