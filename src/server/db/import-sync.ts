// 取り込みの同期（src/server/import/sync.ts）が使う文。接続と範囲の読み取り、取り込み（1件）の書き込み、接続の状態の書き込み。
// 組織の中の表だけを使い、共通の表とは結合しない（docs/data-model.md の「データベースの分け方」）。
// 組織は、接続のワークスペースを workspaces.organization_id で絞って確かめる
import { sql } from 'kysely';
import { previousStatementChanged } from './previous-statement.ts';
import type { ImportItem } from '../import/source.ts';
import type { Statement } from './entry.ts';
import type { OrganizationDb } from './entries.ts';

// 同期が読む接続。認証情報の列は暗号文のまま（復号は呼び出し側）
export type SyncConnection = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  provider: string;
  status: string;
  scope_mode: string;
  ignore_source_due: number;
  settings_json: string;
  credential_ciphertext: string | null;
  credential_key_version: number | null;
  last_success_at: string | null;
  sync_state_json: string;
  consecutive_failures: number;
};

// 登録者が無効でなく、ワークスペースに今も所属している、という条件。離脱と無効化は接続を止める（operations/connection-departure.ts）が、
// 止める前に作られた行や止めた後に所属し直した人の接続を取り込まないための、二重の守りとして残す
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ownerIsActive(eb: any, q: any, ownerColumn: string, workspaceColumn: string) {
  return eb.and([
    eb.exists(
      q
        .selectFrom('users')
        .select('users.id')
        .whereRef('users.id', '=', ownerColumn)
        .where('users.disabled_at', 'is', null),
    ),
    eb.exists(
      q
        .selectFrom('memberships')
        .select('memberships.id')
        .whereRef('memberships.user_id', '=', ownerColumn)
        .whereRef('memberships.workspace_id', '=', workspaceColumn)
        .where('memberships.left_at', 'is', null),
    ),
  ]);
}

export type SyncScope = { source_id: string; source_name: string };

// 削除していない接続を、組織で絞って1件読む。ワークスペースが閉じていれば読まない（閉じたワークスペースは同期を飛ばす）
export async function readSyncConnection(
  db: OrganizationDb,
  workspaceId: string,
  connectionId: string,
): Promise<{ connection: SyncConnection; scopes: SyncScope[] } | undefined> {
  const connection = await db.first(
    db.statement((q) =>
      q
        .selectFrom('connections')
        .innerJoin('workspaces', 'workspaces.id', 'connections.workspace_id')
        .select([
          'connections.id',
          'connections.workspace_id',
          'connections.owner_user_id',
          'connections.provider',
          'connections.status',
          'connections.scope_mode',
          'connections.ignore_source_due',
          'connections.settings_json',
          'connections.credential_ciphertext',
          'connections.credential_key_version',
          'connections.last_success_at',
          'connections.sync_state_json',
          'connections.consecutive_failures',
        ])
        .where('connections.id', '=', connectionId)
        .where('connections.workspace_id', '=', workspaceId)
        .where('connections.deleted_at', 'is', null)
        .where('workspaces.organization_id', '=', db.organizationId)
        .where('workspaces.closed_at', 'is', null)
        // 登録者が今もそのワークスペースにいて、無効にされていない（抜けた人や無効の人の認証情報で取り込まない）
        .where((eb) => ownerIsActive(eb, q, 'connections.owner_user_id', 'connections.workspace_id')),
    ),
  );
  if (connection === undefined) return undefined;
  const scopes = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('connection_scopes')
        .select(['connection_scopes.source_id', 'connection_scopes.source_name'])
        .where('connection_scopes.connection_id', '=', connectionId)
        .orderBy('connection_scopes.source_id'),
    ),
  );
  return { connection, scopes };
}

// 受信箱の末尾の並びの値。受信箱が空なら undefined。組織を確かめた接続のワークスペースの ID だけを渡す（readSyncConnection の後に呼ぶ）。
// 末尾を読んでから書くまでの間に別の取り込みが入ると並びの値が重なりうるが、並びは id で決まるので壊れない
export async function readInboxTailPosition(db: OrganizationDb, workspaceId: string): Promise<string | undefined> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('tasks.position')
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.tray', '=', 'inbox')
        .where('tasks.deleted_at', 'is', null)
        .orderBy('tasks.position', 'desc')
        .orderBy('tasks.id', 'desc')
        .limit(1),
    ),
  );
  return row?.position;
}

// 組織を確かめた接続のワークスペースの ID だけを渡す。取り込み元の入れ物（source_container_id）から、結んだリポジトリの ID への表。ワークスペースのリポジトリは50件まで
export async function readRepositoriesByContainer(
  db: OrganizationDb,
  workspaceId: string,
  provider: string,
): Promise<Map<string, string>> {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('repositories')
        .select(['repositories.id', 'repositories.source_container_id'])
        .where('repositories.workspace_id', '=', workspaceId)
        .where('repositories.provider', '=', provider)
        .where('repositories.source_container_id', 'is not', null)
        .where('repositories.deleted_at', 'is', null)
        .orderBy('repositories.position')
        .orderBy('repositories.id'),
    ),
  );
  const found = new Map<string, string>();
  for (const row of rows) {
    // 同じ入れ物を指すリポジトリが複数あれば、並びの先頭を使う
    if (row.source_container_id !== null && !found.has(row.source_container_id)) {
      found.set(row.source_container_id, row.id);
    }
  }
  return found;
}

// 取り込む1件。値は呼び出し側が整えた後のもの（タイトルの整形、期日、結ぶリポジトリ、並びの値）
export type ImportedTask = {
  taskId: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  assigneeUserId: string;
  repositoryId: string | null;
  position: string;
  title: string;
  kind: 'issue' | 'pull_request' | 'review_request';
  sourceId: string;
  reviewerSourceId: string;
  reviewCycle?: string;
  credentialCiphertext?: string | null;
  credentialKeyVersion?: number | null;
  key: string;
  url: string;
  containerId: string;
  containerName: string;
  status: string;
  dueOn: string | null;
  updatedAt: string;
};

// 取り込み（1件）: tasks と task_sources を、1回の batch() で書く文の組を作る（docs/data-model.md の「書き込みの単位」）。
// batch() は件数 0 の文があっても後ろの文を書くので、どちらも自分の条件に前提を持つ。
//   - tasks は、接続が今も削除されず止まっておらず、ワークスペースが閉じておらず、同じ項目の task_sources が無いことが条件
//   - task_sources は、そのタスクの行があることが条件
// 同じ項目を同時に取り込むと、先に通った 1 つだけが tasks を書き、後の要求は 2 つの文とも 0 件になる
// （D1 の batch() はトランザクションで順に流れるので、後の要求の tasks の文は先の要求の task_sources を見る）
export function importTaskStatements(db: OrganizationDb, task: ImportedTask, at: string): Statement<'organization'>[] {
  const insertTask = db.statement((q) =>
    q
      .insertInto('tasks')
      .columns([
        'id',
        'workspace_id',
        'is_imported',
        'tray',
        'title',
        'body_md',
        'link_url',
        'story_id',
        'category_id',
        'repository_id',
        'sprint_id',
        'column_id',
        'assignee_user_id',
        'points',
        'due_on',
        'today_on',
        'completed_at',
        'completed_by',
        'position',
        'column_position',
        'created_by',
        'created_at',
        'updated_at',
        'deleted_at',
      ])
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(task.taskId).as('id'),
            eb.val(task.workspaceId).as('workspace_id'),
            eb.val(1).as('is_imported'),
            eb.val('inbox').as('tray'),
            eb.val(task.title).as('title'),
            eb.cast<string | null>(eb.val(null), 'text').as('body_md'),
            eb.cast<string | null>(eb.val(null), 'text').as('link_url'),
            eb.cast<string | null>(eb.val(null), 'text').as('story_id'),
            eb.cast<string | null>(eb.val(null), 'text').as('category_id'),
            // 読んだ後に削除されたリポジトリは結ばない
            eb
              .selectFrom('repositories')
              .select('repositories.id')
              .where('repositories.id', '=', task.repositoryId ?? '')
              .where('repositories.workspace_id', '=', task.workspaceId)
              .where('repositories.deleted_at', 'is', null)
              .as('repository_id'),
            eb.cast<string | null>(eb.val(null), 'text').as('sprint_id'),
            eb.cast<string | null>(eb.val(null), 'text').as('column_id'),
            eb.val(task.assigneeUserId).as('assignee_user_id'),
            eb.cast<number | null>(eb.val(null), 'integer').as('points'),
            eb.cast<string | null>(eb.val(null), 'text').as('due_on'),
            eb.cast<string | null>(eb.val(null), 'text').as('today_on'),
            eb.cast<string | null>(eb.val(null), 'text').as('completed_at'),
            eb.cast<string | null>(eb.val(null), 'text').as('completed_by'),
            eb.val(task.position).as('position'),
            eb.cast<string | null>(eb.val(null), 'text').as('column_position'),
            eb.cast<string | null>(eb.val(null), 'text').as('created_by'),
            eb.val(at).as('created_at'),
            eb.val(at).as('updated_at'),
            eb.cast<string | null>(eb.val(null), 'text').as('deleted_at'),
          ])
          .where((eb) =>
            eb.and([
              eb.exists(
                q
                  .selectFrom('connections')
                  .innerJoin('workspaces', 'workspaces.id', 'connections.workspace_id')
                  .select('connections.id')
                  .where('connections.id', '=', task.connectionId)
                  .$if(task.credentialCiphertext !== undefined, (qb) =>
                    qb
                      .where('connections.credential_ciphertext', 'is', task.credentialCiphertext ?? null)
                      .where('connections.credential_key_version', 'is', task.credentialKeyVersion ?? null),
                  )
                  .where('connections.workspace_id', '=', task.workspaceId)
                  .where('connections.deleted_at', 'is', null)
                  .where('connections.status', '!=', 'stopped')
                  .where('workspaces.organization_id', '=', db.organizationId)
                  .where('workspaces.closed_at', 'is', null)
                  .where((cb) => ownerIsActive(cb, q, 'connections.owner_user_id', 'connections.workspace_id')),
              ),
              eb.not(
                eb.exists(
                  q
                    .selectFrom('task_sources')
                    .select('task_sources.task_id')
                    .where('task_sources.workspace_id', '=', task.workspaceId)
                    .where('task_sources.provider', '=', task.provider)
                    .where('task_sources.source_kind', '=', task.kind)
                    .where('task_sources.source_id', '=', task.sourceId)
                    .where('task_sources.reviewer_source_id', '=', task.reviewerSourceId),
                ),
              ),
            ]),
          ),
      ),
  );

  const insertSource = db.statement((q) =>
    q
      .insertInto('task_sources')
      .columns([
        'task_id',
        'workspace_id',
        'connection_id',
        'provider',
        'source_kind',
        'source_id',
        'reviewer_source_id',
        'review_cycle',
        'source_key',
        'source_url',
        'source_container_id',
        'source_container_name',
        'source_status',
        'source_due_on',
        'source_updated_at',
        'is_source_done',
        'missing_since_at',
        'last_seen_at',
        'created_at',
        'updated_at',
      ])
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(task.taskId).as('task_id'),
            eb.val(task.workspaceId).as('workspace_id'),
            eb.val(task.connectionId).as('connection_id'),
            eb.val(task.provider).as('provider'),
            eb.val(task.kind).as('source_kind'),
            eb.val(task.sourceId).as('source_id'),
            eb.val(task.reviewerSourceId).as('reviewer_source_id'),
            eb.cast<string | null>(eb.val(task.reviewCycle ?? null), 'text').as('review_cycle'),
            eb.val(task.key).as('source_key'),
            eb.val(task.url).as('source_url'),
            eb.val(task.containerId).as('source_container_id'),
            eb.val(task.containerName).as('source_container_name'),
            eb.val(task.status).as('source_status'),
            eb.cast<string | null>(eb.val(task.dueOn), 'text').as('source_due_on'),
            eb.val(task.updatedAt).as('source_updated_at'),
            eb.val(0).as('is_source_done'),
            eb.cast<string | null>(eb.val(null), 'text').as('missing_since_at'),
            eb.val(at).as('last_seen_at'),
            eb.val(at).as('created_at'),
            eb.val(at).as('updated_at'),
          ])
          .where((eb) =>
            eb.exists(
              q
                .selectFrom('tasks')
                .select('tasks.id')
                .where('tasks.id', '=', task.taskId)
                .where('tasks.workspace_id', '=', task.workspaceId)
                .where('tasks.is_imported', '=', 1),
            ),
          ),
      ),
  );

  return task.reviewCycle === undefined
    ? [insertTask, insertSource]
    : [insertTask, insertSource, reviewCycleStatement(db, task.taskId, task.workspaceId, task.reviewCycle, at)];
}

// 取り込み済みの1件に、取り込み元が持つ属性（タイトル、状態、期限、URL、完了の印）だけを書き戻す。値は呼び出し側が整えた後のもの
export type ImportedUpdate = {
  workspaceId: string;
  connectionId: string;
  provider: string;
  credentialCiphertext: string | null;
  credentialKeyVersion: number | null;
  kind: 'issue' | 'pull_request';
  sourceId: string;
  title: string;
  url: string;
  status: string;
  dueOn: string | null;
  isDone: boolean;
  updatedAt: string;
};

// 取り込み済みの1件の更新（docs/data-model.md の「書き込みの単位」）: tasks のタイトルと task_sources の取り込み元の属性だけを、1回の batch() で書く文の組を作る。
// 列、スプリント、親、ポイント、期日、担当、リポジトリ、完了は書かない。変更の履歴（change_logs）も書かない。
// 完了の印（is_source_done）は付け外しだけで、タスクの完了には触れない。
// どちらの文も、同じ項目の task_sources の行があり、その source_updated_at が取り込み元の更新日時以前（古い頁で新しい値を戻さない）ことを条件にする。task_sources の文は加えて、値がどれか変わるときだけ書く。
// tasks の文を先に流すので、task_sources の条件は tasks の文でも同じ値を見る。行が無い（まだ取り込んでいない）項目では、どちらも0件になる
export function updateImportedStatements(
  db: OrganizationDb,
  update: ImportedUpdate,
  at: string,
): Statement<'organization'>[] {
  const updateTask = db.statement((q) =>
    q
      .updateTable('tasks')
      .set({ title: update.title, updated_at: at })
      .where('tasks.workspace_id', '=', update.workspaceId)
      .where('tasks.is_imported', '=', 1)
      .where('tasks.deleted_at', 'is', null)
      .where('tasks.title', '!=', update.title)
      // 項目の一意のキー（task_sources の一意の索引）で1行に絞ってから tasks を引く（ワークスペースのタスクを全件なめない）
      .where(
        'tasks.id',
        '=',
        q
          .selectFrom('task_sources')
          .select('task_sources.task_id')
          .where('task_sources.workspace_id', '=', update.workspaceId)
          .where('task_sources.provider', '=', update.provider)
          .where('task_sources.source_kind', '=', update.kind)
          .where('task_sources.source_id', '=', update.sourceId)
          .where('task_sources.reviewer_source_id', '=', '')
          .where('task_sources.source_updated_at', '<=', update.updatedAt),
      )
      .where((eb) => activeConnectionExists(db, q, eb, update)),
  );
  const updateSource = db.statement((q) =>
    q
      .updateTable('task_sources')
      .set({
        source_url: update.url,
        source_status: update.status,
        source_due_on: update.dueOn,
        is_source_done: update.isDone ? 1 : 0,
        source_updated_at: update.updatedAt,
        last_seen_at: at,
        updated_at: at,
      })
      .where('task_sources.workspace_id', '=', update.workspaceId)
      .where('task_sources.provider', '=', update.provider)
      .where('task_sources.source_kind', '=', update.kind)
      .where('task_sources.source_id', '=', update.sourceId)
      .where('task_sources.reviewer_source_id', '=', '')
      .where('task_sources.source_updated_at', '<=', update.updatedAt)
      // 何も変わらない項目は書かない（同期のたびに全行を書き直さない）
      .where((eb) =>
        eb.or([
          eb('task_sources.source_updated_at', '<', update.updatedAt),
          eb('task_sources.source_url', '!=', update.url),
          eb('task_sources.source_status', '!=', update.status),
          eb('task_sources.source_due_on', 'is not', update.dueOn),
          eb('task_sources.is_source_done', '!=', update.isDone ? 1 : 0),
        ]),
      )
      .where((eb) =>
        eb.and([
          eb.exists(
            q
              .selectFrom('tasks')
              .select('tasks.id')
              .where(sql<boolean>`tasks.id = task_sources.task_id`)
              .where('tasks.workspace_id', '=', update.workspaceId)
              .where('tasks.is_imported', '=', 1)
              .where('tasks.deleted_at', 'is', null),
          ),
          activeConnectionExists(db, q, eb, update),
        ]),
      ),
  );
  return [updateTask, updateSource];
}

// 接続が今も削除されず止まっておらず、認証情報が読んだときのままで、ワークスペースが閉じておらず、登録者が今もいる、という条件
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function activeConnectionExists(db: OrganizationDb, q: any, eb: any, update: ImportedUpdate) {
  return eb.exists(
    q
      .selectFrom('connections')
      .innerJoin('workspaces', 'workspaces.id', 'connections.workspace_id')
      .select('connections.id')
      .where('connections.id', '=', update.connectionId)
      .where('connections.credential_ciphertext', 'is', update.credentialCiphertext)
      .where('connections.credential_key_version', 'is', update.credentialKeyVersion)
      .where('connections.workspace_id', '=', update.workspaceId)
      .where('connections.deleted_at', 'is', null)
      .where('connections.status', '!=', 'stopped')
      .where('workspaces.organization_id', '=', db.organizationId)
      .where('workspaces.closed_at', 'is', null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .where((cb: any) => ownerIsActive(cb, q, 'connections.owner_user_id', 'connections.workspace_id')),
  );
}

// 同期の結果として接続に書く値。成功は続きの位置（なければ空の状態）まで、失敗は種別ごと
export type SyncOutcome =
  | { kind: 'success'; syncStateJson: string; lastSuccessAt?: string }
  | { kind: 'progress'; syncStateJson: string }
  | { kind: 'auth_failed'; message: string; syncStateJson?: string }
  | { kind: 'error'; message: string; syncStateJson?: string };

// 接続の状態を1文で書く。接続が今も削除されておらず、止まっていないことが条件
// （同期の最中に止められた接続や削除された接続を、成功で書き戻さない）。ほかの失敗の回数は、読み直さず SQL の中で足す
export function syncOutcomeStatement(
  db: OrganizationDb,
  connection: {
    id: string;
    workspaceId: string;
    credential?: string | null;
    keyVersion?: number | null;
    // 同期が読んだ ignore_source_due。終わるときに値が変わっていたら、次の同期が全部を読むよう最後の成功と続きを空にする
    ignoreSourceDue?: number;
  },
  outcome: SyncOutcome,
  at: string,
): Statement<'organization'> {
  return db.statement((q) => {
    const base = q.updateTable('connections');
    const set =
      outcome.kind === 'progress'
        ? base.set({ sync_state_json: outcome.syncStateJson, updated_at: at })
        : outcome.kind === 'success'
          ? base.set((eb) => ({
              status: 'active',
              stopped_reason: null,
              sync_state_json:
                connection.ignoreSourceDue === undefined
                  ? outcome.syncStateJson
                  : eb
                      .case()
                      .when('connections.ignore_source_due', '=', connection.ignoreSourceDue)
                      .then(outcome.syncStateJson)
                      .else('{}')
                      .end(),
              last_success_at:
                connection.ignoreSourceDue === undefined
                  ? (outcome.lastSuccessAt ?? at)
                  : eb
                      .case()
                      .when('connections.ignore_source_due', '=', connection.ignoreSourceDue)
                      .then(outcome.lastSuccessAt ?? at)
                      .else(null)
                      .end(),
              consecutive_failures: 0,
              last_error_message: null,
              last_error_at: null,
              updated_at: at,
            }))
          : outcome.kind === 'auth_failed'
            ? base.set({
                status: 'stopped',
                stopped_reason: 'auth_failed',
                ...(outcome.syncStateJson === undefined ? {} : { sync_state_json: outcome.syncStateJson }),
                last_error_message: outcome.message,
                last_error_at: at,
                updated_at: at,
              })
            : base.set((eb) => ({
                status: 'error',
                ...(outcome.syncStateJson === undefined ? {} : { sync_state_json: outcome.syncStateJson }),
                consecutive_failures: eb('connections.consecutive_failures', '+', 1),
                last_error_message: outcome.message,
                last_error_at: at,
                updated_at: at,
              }));
    return set
      .where('connections.id', '=', connection.id)
      .$if(connection.credential !== undefined, (qb) =>
        qb
          .where('connections.credential_ciphertext', 'is', connection.credential ?? null)
          .where('connections.credential_key_version', 'is', connection.keyVersion ?? null),
      )
      .where('connections.workspace_id', '=', connection.workspaceId)
      .where('connections.deleted_at', 'is', null)
      .where('connections.status', '!=', 'stopped')
      .where((eb) =>
        eb.exists(
          q
            .selectFrom('workspaces')
            .select('workspaces.id')
            .where('workspaces.id', '=', connection.workspaceId)
            .where('workspaces.organization_id', '=', db.organizationId)
            .where('workspaces.deleted_at', 'is', null),
        ),
      );
  });
}

// target の順次照合。最後に読んだ task_id から続け、全走査の欠落では何も変えない。
export async function readReviewTarget(db: OrganizationDb, connection: SyncConnection, scopeId: string, after: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('task_sources as s')
        .innerJoin('tasks as t', 't.id', 's.task_id')
        .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
        .select([
          's.task_id',
          's.source_id',
          's.source_key',
          's.reviewer_source_id',
          's.review_cycle',
          's.review_revision',
          's.source_updated_at',
          's.updated_at',
        ])
        .where('s.workspace_id', '=', connection.workspace_id)
        .where('t.workspace_id', '=', connection.workspace_id)
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .where('s.connection_id', '=', connection.id)
        .where('s.provider', '=', connection.provider)
        .where('s.source_kind', '=', 'review_request')
        .where('s.source_container_id', '=', scopeId)
        .where('t.deleted_at', 'is', null)
        .where('s.task_id', '>', after)
        .orderBy('s.task_id')
        .limit(1),
    ),
  );
}
export type ReviewTarget = NonNullable<Awaited<ReturnType<typeof readReviewTarget>>>;

// target で確かめた項目だけを書く。CAS と回の記録で並行・遅着の再復帰を防ぐ。
export function reviewUpdateStatements(
  db: OrganizationDb,
  connection: SyncConnection,
  target: ReviewTarget,
  item: ImportItem,
  position: string,
  at: string,
): Statement<'organization'>[] {
  const newCycle = target.review_cycle !== item.reviewCycle;
  const reopen = newCycle && target.review_cycle !== null;
  const claim = db.statement((q) =>
    q
      .updateTable('task_sources')
      .set((eb) => ({
        review_revision: eb('review_revision', '+', 1),
        ...(reopen ? { last_received_at: at } : {}),
        review_cycle: item.reviewCycle!,
        is_source_done: item.isDone ? 1 : 0,
        source_updated_at: new Date(item.updatedAt).toISOString(),
        last_seen_at: at,
        updated_at: at,
      }))
      .where('task_id', '=', target.task_id)
      .where('workspace_id', '=', connection.workspace_id)
      .where('connection_id', '=', connection.id)
      .where('provider', '=', connection.provider)
      .where('source_kind', '=', 'review_request')
      .where('source_id', '=', item.sourceId)
      .where('reviewer_source_id', '=', item.reviewerSourceId)
      .where('review_cycle', 'is', target.review_cycle)
      .where('review_revision', '=', target.review_revision)
      .where('updated_at', '=', target.updated_at)
      .where('source_updated_at', '<=', new Date(item.updatedAt).toISOString())
      .$if(newCycle, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              q
                .selectFrom('review_request_cycles')
                .select('task_id')
                .where('task_id', '=', target.task_id)
                .where('review_cycle', '=', item.reviewCycle!),
            ),
          ),
        ),
      )
      .where((eb) =>
        eb.exists(
          q
            .selectFrom('connections as c')
            .innerJoin('workspaces as w', 'w.id', 'c.workspace_id')
            .select('c.id')
            .where('c.id', '=', connection.id)
            .where('c.workspace_id', '=', connection.workspace_id)
            .where('w.organization_id', '=', db.organizationId)
            .where('w.closed_at', 'is', null)
            .where('c.deleted_at', 'is', null)
            .where('c.status', '!=', 'stopped')
            .where('c.credential_ciphertext', 'is', connection.credential_ciphertext)
            .where('c.credential_key_version', 'is', connection.credential_key_version)
            .where((cb) => ownerIsActive(cb, q, 'c.owner_user_id', 'c.workspace_id')),
        ),
      )
      .where((eb) =>
        eb.exists(
          q
            .selectFrom('tasks')
            .select('id')
            .where('id', '=', target.task_id)
            .where('workspace_id', '=', connection.workspace_id)
            .where('deleted_at', 'is', null),
        ),
      ),
  );
  // claim の直後だけが tasks を変える。完了印ではタスクを自動完了にしない。
  const statements: Statement<'organization'>[] = [claim];
  if (reopen) {
    statements.push(
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({
            tray: 'inbox',
            completed_at: null,
            completed_by: null,
            sprint_id: null,
            column_id: null,
            column_position: null,
            story_id: null,
            today_on: null,
            position,
            updated_at: at,
          })
          .where('id', '=', target.task_id)
          .where('workspace_id', '=', connection.workspace_id)
          .where('deleted_at', 'is', null)
          .where(previousStatementChanged),
      ),
    );
    statements.push(
      db.statement((q) =>
        q
          .updateTable('sprint_entries')
          .set({ ended_at: at, outcome: 'removed' })
          .where('workspace_id', '=', connection.workspace_id)
          .where('task_id', '=', target.task_id)
          .where('ended_at', 'is', null)
          .where(previousStatementChanged),
      ),
    );
  }
  // 過去の回を記録しておく。completions と xp_grants には触れない。
  statements.push(reviewCycleStatement(db, target.task_id, connection.workspace_id, item.reviewCycle!, at));
  return statements;
}

function reviewCycleStatement(db: OrganizationDb, taskId: string, workspaceId: string, cycle: string, at: string) {
  return db.statement((q) =>
    q
      .insertInto('review_request_cycles')
      .columns(['task_id', 'review_cycle', 'completion_id', 'created_at'])
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(taskId).as('task_id'),
            eb.val(cycle).as('review_cycle'),
            eb.cast<string | null>(eb.val(null), 'text').as('completion_id'),
            eb.val(at).as('created_at'),
          ])
          .where((eb) =>
            eb.exists(
              q
                .selectFrom('task_sources')
                .innerJoin('workspaces', 'workspaces.id', 'task_sources.workspace_id')
                .select('task_id')
                .where('task_id', '=', taskId)
                .where('workspace_id', '=', workspaceId)
                .where('workspaces.organization_id', '=', db.organizationId)
                .where('review_cycle', '=', cycle)
                .where('workspaces.deleted_at', 'is', null),
            ),
          ),
      )
      .onConflict((oc) => oc.columns(['task_id', 'review_cycle']).doNothing()),
  );
}
