// 接続（取り込み元の登録）の操作: 一覧、登録、範囲の候補、範囲の保存（docs/requirements.md の「取り込み」）。
// 取り込み元への通信と認証情報の暗号化は、組織の道具（organization-tools.ts）だけを通す。処理は env も fetch も受け取らない。
// 認証情報（平文、暗号文、鍵の版）は応答にもログにも出さない。出すのは末尾4文字だけ。
// 接続の表（connections）は組織の ID を持たないので、確かめたワークスペースの ID（workspace.workspaceId）で絞る
import { now } from '../../shared/clock.ts';
import {
  CONNECTIONS_PER_MEMBER_MAX,
  CONNECTION_MANUAL_SYNC_INTERVAL_SECONDS,
  CONNECTION_OWNER_GONE_REASONS,
  connectionCreate,
  connectionDelete,
  connectionList,
  connectionMappingSave,
  CONNECTION_STATUS_MAPPINGS_MAX,
  connectionScopeCandidates,
  connectionScopesSave,
  connectionStop,
  connectionSync,
  connectionUpdate,
  CONNECTION_CREDENTIAL_RESUME_REASONS,
  isOwnerGoneStop,
  resumesOnCredential,
  type Connection,
  type ConnectionCreateProblem,
} from '../../shared/operations/connection/index.ts';
import {
  jsonList,
  previousStatementChanged,
  type Expression,
  type ExpressionBuilder,
  type OrganizationDb,
  type QueryCreator,
  type OrganizationTables,
  type SqlBool,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { CredentialKeysError } from '../crypto/credential.ts';
import { ImportSourceError, isImportSourceKind, type ScopeCandidate } from '../import/index.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import type { BoundImportSource, OrganizationTools } from './organization-tools.ts';
import {
  activeMemberName,
  actorUserIdOf,
  changeLogColumns,
  isLeaderOrAdmin,
  openWorkspace,
  throwIfClosed,
} from './write-guards.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;

// 削除していない接続の行（ワークスペースで絞る）
function liveConnections(from: From, workspaceId: string) {
  return from
    .selectFrom('connections as c')
    .where('c.workspace_id', '=', workspaceId)
    .where('c.deleted_at', 'is', null);
}

// 接続の一覧の形に直して返す。connectionId を渡すとその1件。暗号文と同期の状態は選ばない
async function readConnections(db: OrganizationDb, workspaceId: string, connectionId?: string): Promise<Connection[]> {
  const [connections, scopes, mappings, statuses] = await db.batch([
    db.statement((q) => {
      const query = liveConnections(q, workspaceId)
        .leftJoin('users as u', (join) =>
          join.onRef('u.id', '=', 'c.owner_user_id').on('u.organization_id', '=', db.organizationId),
        )
        .select([
          'c.id',
          'c.workspace_id',
          'c.provider',
          'c.name',
          'c.status',
          'c.stopped_reason',
          'c.scope_mode',
          'c.ignore_source_due',
          'c.credential_last4',
          'c.owner_user_id',
          'u.name as owner_name',
          'c.last_success_at',
          'c.last_error_message',
          'c.last_error_at',
          'c.consecutive_failures',
          'c.created_at',
        ])
        .orderBy('c.created_at')
        .orderBy('c.id');
      return connectionId === undefined ? query : query.where('c.id', '=', connectionId);
    }),
    db.statement((q) => {
      const query = q
        .selectFrom('connection_scopes as s')
        .innerJoin('connections as c', 'c.id', 's.connection_id')
        .where('c.workspace_id', '=', workspaceId)
        .where('c.deleted_at', 'is', null)
        .select(['s.connection_id', 's.source_id', 's.source_name'])
        .orderBy('s.source_name')
        .orderBy('s.source_id');
      return connectionId === undefined ? query : query.where('c.id', '=', connectionId);
    }),
    db.statement((q) => {
      const query = q
        .selectFrom('connection_status_mappings as m')
        .innerJoin('connections as c', 'c.id', 'm.connection_id')
        .where('c.workspace_id', '=', workspaceId)
        .where('c.deleted_at', 'is', null)
        .select(['m.connection_id', 'm.source_status', 'm.column_id'])
        .orderBy('m.source_status');
      return connectionId === undefined ? query : query.where('c.id', '=', connectionId);
    }),
    // 取り込んだ項目に現れた状態名（対応を選べる状態）
    db.statement((q) => {
      const query = q
        .selectFrom('task_sources as ts')
        .innerJoin('connections as c', 'c.id', 'ts.connection_id')
        .where('c.workspace_id', '=', workspaceId)
        .where('ts.workspace_id', '=', workspaceId)
        .where('c.deleted_at', 'is', null)
        .select(['ts.connection_id', 'ts.source_status'])
        .distinct()
        .orderBy('ts.source_status');
      return connectionId === undefined ? query : query.where('c.id', '=', connectionId);
    }),
  ] as const);
  const mappingsOf = new Map<string, { source_status: string; column_id: string }[]>();
  for (const row of mappings.rows) {
    const list = mappingsOf.get(row.connection_id) ?? [];
    list.push({ source_status: row.source_status, column_id: row.column_id });
    mappingsOf.set(row.connection_id, list);
  }
  const statusesOf = new Map<string, Set<string>>();
  for (const row of statuses.rows) {
    const set = statusesOf.get(row.connection_id) ?? new Set<string>();
    set.add(row.source_status);
    statusesOf.set(row.connection_id, set);
  }
  const scopesOf = new Map<string, { id: string; name: string }[]>();
  for (const row of scopes.rows) {
    const list = scopesOf.get(row.connection_id) ?? [];
    list.push({ id: row.source_id, name: row.source_name });
    scopesOf.set(row.connection_id, list);
  }
  return connections.rows.map((row) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    provider: row.provider,
    name: row.name,
    status: row.status as Connection['status'],
    stopped_reason: row.stopped_reason,
    scope_mode: row.scope_mode as Connection['scope_mode'],
    scopes: scopesOf.get(row.id) ?? [],
    ignore_source_due: Number(row.ignore_source_due) === 1,
    status_mappings: mappingsOf.get(row.id) ?? [],
    // 保存済みの対応の状態名を先に残し、残りの枠に取り込んだ状態名を入れる（切り詰めで保存済みの対応を落とさない）
    source_statuses: statusNames(mappingsOf.get(row.id) ?? [], statusesOf.get(row.id)),
    credential_last4: row.credential_last4,
    owner_user_id: row.owner_user_id,
    owner_name: row.owner_name,
    last_success_at: row.last_success_at,
    last_error_message: row.last_error_message,
    last_error_at: row.last_error_at,
    consecutive_failures: Number(row.consecutive_failures),
    created_at: row.created_at,
  }));
}

function statusNames(mappings: readonly { source_status: string }[], seen: ReadonlySet<string> | undefined): string[] {
  const names = new Set(mappings.map((mapping) => mapping.source_status));
  for (const name of [...(seen ?? [])].sort()) {
    if (names.size >= CONNECTION_STATUS_MAPPINGS_MAX) break;
    names.add(name);
  }
  return [...names].sort();
}

// 鍵の設定不備だけを区別する。復号の失敗など想定外の例外は従来どおり伝える。
async function credentialOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof CredentialKeysError) throw new ApiError(503, 'credential_keys_unavailable');
    throw err;
  }
}

function rejected(problem: ConnectionCreateProblem, message: string): ApiError {
  return new ApiError(400, 'invalid_input', [{ path: 'credential', code: problem, message }]);
}

// 取り込み元の失敗を応答の失敗に直す。メッセージは固定の文だけで、取り込み元の応答や認証情報を含まない
function importFailure(err: unknown, onRejected: () => ApiError): never {
  if (err instanceof ImportSourceError) {
    if (err.failure === 'invalid_format') throw rejected('credential_shape', '認証情報の形が合わない');
    if (err.failure === 'unauthorized' || err.failure === 'forbidden') throw onRejected();
    throw new ApiError(503, 'unavailable');
  }
  throw err;
}

async function verifyCredential(source: BoundImportSource, value: string): Promise<string> {
  const credential = value.trim();
  if (!source.isCredentialShape(credential)) throw rejected('credential_shape', '認証情報の形が合わない');
  try {
    await source.verifyCredential(credential);
  } catch (err) {
    importFailure(err, () => rejected('credential_rejected', '取り込み元が認証情報を受け付けなかった'));
  }
  return credential;
}

async function sealCredential(
  tools: OrganizationTools,
  source: BoundImportSource,
  credential: string,
  connectionId: string,
) {
  const sealed = await credentialOperation(() => tools.sealCredential(credential, connectionId));
  return {
    credential_ciphertext: sealed.ciphertext,
    credential_key_version: sealed.keyVersion,
    credential_last4: source.credentialLast4(credential),
  };
}

export const connectionListOperation = implement(connectionList, async ({ db, workspace }) => ({
  connections: await readConnections(db, workspace.workspaceId),
}));

export const connectionCreateOperation = implement(connectionCreate, async ({ db, actor, tools, workspace, input }) => {
  const ownerUserId = actorUserIdOf(actor);
  const workspaceId = workspace.workspaceId;
  const organizationId = db.organizationId;
  if (!isImportSourceKind(input.provider)) {
    throw new ApiError(400, 'invalid_input', [
      {
        path: 'provider',
        code: 'provider_unknown' satisfies ConnectionCreateProblem,
        message: '取り込み元の種類が無い',
      },
    ]);
  }
  const source = tools.importSource(input.provider);
  const settings = source.parseSettings(undefined);
  if (settings === null) throw new Error('取り込み元の既定の設定が検証を通らない');
  const verified = await verifyCredential(source, input.credential);
  const at = now();
  const stamp = at.toISOString();
  const connectionId = uuidv7(at);
  const credential = await sealCredential(tools, source, verified, connectionId);

  const results = await db.batch([
    // 閉じたワークスペースへは入れない（登録の関数が見る閉じたかどうかは読み取りの時点の値）
    db.statement((q) =>
      q
        .insertInto('connections')
        .columns([
          'id',
          'workspace_id',
          'owner_user_id',
          'provider',
          'name',
          'status',
          'scope_mode',
          'settings_json',
          'credential_ciphertext',
          'credential_key_version',
          'credential_last4',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(connectionId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(ownerUserId).as('owner_user_id'),
              eb.val(input.provider).as('provider'),
              eb.val(input.name).as('name'),
              eb.val('active').as('status'),
              eb.val('include').as('scope_mode'),
              eb.val(JSON.stringify(settings)).as('settings_json'),
              eb.val(credential.credential_ciphertext).as('credential_ciphertext'),
              eb.val(credential.credential_key_version).as('credential_key_version'),
              eb.val(credential.credential_last4).as('credential_last4'),
              eb.val(stamp).as('created_at'),
              eb.val(stamp).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
            // PAT の検証中に抜けた（外された）か無効にされた人の接続を作らない（離脱と無効化が止める接続は、その時点でまだ無い。#1546）
            .where((eb) => ownerStillAllowed(eb, q, organizationId, workspaceId, ownerUserId))
            // 1人が1つのワークスペースに持てる接続の数に上限を置く（共通の D1 を埋める登録の繰り返しを止める）
            .where(
              (eb) =>
                eb
                  .selectFrom('connections as limit_c')
                  .select((inner) => inner.fn.countAll<number>().as('n'))
                  .where('limit_c.workspace_id', '=', workspaceId)
                  .where('limit_c.owner_user_id', '=', ownerUserId)
                  .where('limit_c.deleted_at', 'is', null),
              '<',
              CONNECTIONS_PER_MEMBER_MAX,
            ),
        ),
    ),
    // 履歴には表示名と種類だけを残す。認証情報は入れない
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(ownerUserId).as('actor_user_id'),
              eb.val('connection').as('entity_type'),
              eb.val(connectionId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify({ name: [null, input.name], provider: [null, input.provider] })).as('changes_json'),
              eb.val(stamp).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ] as const);
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    const allowed = await db.first(
      db.statement((q) =>
        q
          .selectNoFrom((eb) => eb.val(1).as('allowed'))
          .where((eb) => ownerStillAllowed(eb, q, organizationId, workspaceId, ownerUserId)),
      ),
    );
    if (allowed === undefined) throw new ApiError(403, 'forbidden');
    // 書けなかった理由は、閉じたワークスペースでも権限を失ったのでもなければ接続の数の上限
    throw new ApiError(409, 'conflict', { reason: 'connection_limit' });
  }
  const [connection] = await readConnections(db, workspaceId, connectionId);
  if (connection === undefined) throw new ApiError(409, 'conflict');
  return { connection };
});

// 接続を書く人が、今もそのワークスペースのメンバーか、無効でない管理者である。PAT を取り込み元で確かめている間に
// 抜けた（外された）か無効にされた人の接続を、作りも書き換えもしない
function ownerStillAllowed<DB extends Tables, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  q: From,
  organizationId: string,
  workspaceId: string,
  ownerUserId: string,
) {
  return eb.or([
    eb.exists(activeMemberName(q, organizationId, workspaceId, ownerUserId)),
    eb.exists(
      q
        .selectFrom('users')
        .select('id')
        .where('id', '=', ownerUserId)
        .where('organization_id', '=', organizationId)
        .where('disabled_at', 'is', null)
        .where('is_admin', '=', 1),
    ),
  ]);
}

// 登録した本人の、削除していない接続の行。無い（別のワークスペース、別の組織、削除済み）は 404、本人でなければ 403
async function ownConnection(db: OrganizationDb, actorUserId: string, workspaceId: string, connectionId: string) {
  const row = await db.first(
    db.statement((q) =>
      liveConnections(q, workspaceId)
        .select([
          'c.id',
          'c.owner_user_id',
          'c.provider',
          'c.credential_ciphertext',
          'c.credential_key_version',
          'c.last_manual_sync_at',
          'c.status',
          'c.stopped_reason',
          'c.ignore_source_due',
        ])
        // 本人が今もそのワークスペースのメンバーか（403 で断らなければ、持ち主は呼んだ本人）
        .select((eb) =>
          eb.exists(activeMemberName(q, db.organizationId, workspaceId, actorUserId)).as('owner_is_member'),
        )
        .where('c.id', '=', connectionId),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  if (row.owner_user_id !== actorUserId) throw new ApiError(403, 'forbidden');
  return row;
}

// 持ち主が去って止めた接続は、保存した認証情報で取り込み元に問い合わせない（範囲の候補と保存は 409 の connection_stopped）。
// 去ったと見るのは、離脱・無効化の理由で止めたとき（書かれない workspace_closed の行も同じ）と、止まった接続の持ち主が今のメンバーでないとき
// （離脱と無効化は既に止まった接続の理由を書き換えないので、先に auth_failed などで止まった接続は理由だけでは分からない）
function throwIfOwnerGone(row: {
  status: string;
  stopped_reason: string | null;
  owner_is_member: number | boolean | null;
}): void {
  if (isOwnerGoneStop(row) || (row.status === 'stopped' && !row.owner_is_member)) {
    throw new ApiError(409, 'conflict', { reason: 'connection_stopped' });
  }
}

export const connectionUpdateOperation = implement(connectionUpdate, async ({ db, actor, tools, workspace, input }) => {
  const ownerUserId = actorUserIdOf(actor);
  const { workspaceId } = workspace;
  const { organizationId } = db;
  const row = await ownConnection(db, ownerUserId, workspaceId, input.connection_id);
  let credential: Awaited<ReturnType<typeof sealCredential>> | undefined;
  if (input.credential !== undefined) {
    if (!isImportSourceKind(row.provider)) throw new ApiError(409, 'conflict', { reason: 'provider_unknown' });
    const source = tools.importSource(row.provider);
    const verified = await verifyCredential(source, input.credential);
    credential = await sealCredential(tools, source, verified, row.id);
  }

  const at = now();
  const stamp = at.toISOString();
  const results = await db.batch([
    // 書く直前の表示名を履歴に使い、認証情報の更新は値を含まない印だけを残す。
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          liveConnections(q, workspaceId)
            .where('c.id', '=', row.id)
            .where('c.owner_user_id', '=', ownerUserId)
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
            // PAT の検証中に所属や管理者の権限を失った場合は書かない。
            .where((eb) => ownerStillAllowed(eb, q, organizationId, workspaceId, ownerUserId))
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(ownerUserId).as('actor_user_id'),
              eb.val('connection').as('entity_type'),
              eb.ref('c.id').as('entity_id'),
              eb.val('update').as('action'),
              eb
                .fn<string>('json_patch', [
                  eb.fn<string>('json_patch', [
                    eb
                      .case()
                      .when('c.name', '!=', input.name)
                      .then(
                        eb.fn('json_object', [
                          eb.val('name'),
                          eb.fn('json_array', [eb.ref('c.name'), eb.val(input.name)]),
                        ]),
                      )
                      .else('{}')
                      .end(),
                    eb.val(credential === undefined ? '{}' : '{"credential_updated":[null,true]}'),
                  ]),
                  // 再開する更新（下の接続の更新と同じ条件）は、状態と停止の理由の前後も残す
                  credential === undefined
                    ? eb.val('{}')
                    : eb
                        .case()
                        .when(
                          eb.and([
                            eb('c.stopped_reason', 'in', [...CONNECTION_CREDENTIAL_RESUME_REASONS]),
                            eb.exists(activeMemberName(q, organizationId, workspaceId, ownerUserId)),
                          ]),
                        )
                        .then(
                          eb.fn('json_object', [
                            eb.val('status'),
                            eb.fn('json_array', [eb.ref('c.status'), eb.val('active')]),
                            eb.val('stopped_reason'),
                            eb.fn('json_array', [eb.ref('c.stopped_reason'), eb.val(null)]),
                          ]),
                        )
                        .else('{}')
                        .end(),
                ])
                .as('changes_json'),
              eb.val(stamp).as('created_at'),
            ]),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('connections')
        .set({ name: input.name, updated_at: stamp })
        .$if(credential !== undefined, (query) =>
          query.set((eb) => {
            // 認証の失敗、離脱、無効化で止めた接続を再開するのは、持ち主が今もそのワークスペースのメンバーのときだけ。
            // 抜けた管理者が抜けたワークスペースの接続を戻さない。owner と leader の停止と、書かれない workspace_closed の行は戻さない
            const resumes = eb.and([
              eb('stopped_reason', 'in', [...CONNECTION_CREDENTIAL_RESUME_REASONS]),
              eb.exists(activeMemberName(q, organizationId, workspaceId, ownerUserId)),
            ]);
            return {
              ...credential,
              // 同期側の指紋で古い続きは使われないが、照合の位置も含めて PAT の更新時点で両方消す。
              sync_state_json: '{}',
              reconcile_state_json: '{}',
              // 新しい認証情報で見える範囲が変わりうるので、次の同期は差分でなく全部を読む
              last_success_at: null,
              status: eb.case().when(resumes).then('active').else(eb.ref('status')).end(),
              stopped_reason: eb.case().when(resumes).then(null).else(eb.ref('stopped_reason')).end(),
              last_error_message: eb.case().when(resumes).then(null).else(eb.ref('last_error_message')).end(),
              last_error_at: eb.case().when(resumes).then(null).else(eb.ref('last_error_at')).end(),
              consecutive_failures: eb.case().when(resumes).then(0).else(eb.ref('consecutive_failures')).end(),
            };
          }),
        )
        .where('id', '=', row.id)
        .where('workspace_id', '=', workspaceId)
        .where(previousStatementChanged),
    ),
  ] as const);
  if ((results[1]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    await ownConnection(db, ownerUserId, workspaceId, row.id);
    throw new ApiError(403, 'forbidden');
  }
  const [connection] = await readConnections(db, workspaceId, row.id);
  if (connection === undefined) throw new ApiError(404, 'not_found');
  return { connection };
});

// 保存した認証情報で取り込み元に範囲の候補を問い合わせる。復号は呼んだ処理の中だけで、平文を外に出さない
async function fetchCandidates(
  tools: OrganizationTools,
  row: Awaited<ReturnType<typeof ownConnection>>,
): Promise<ScopeCandidate[]> {
  if (!isImportSourceKind(row.provider)) throw new ApiError(409, 'conflict', { reason: 'provider_unknown' });
  if (row.credential_ciphertext === null || row.credential_key_version === null) {
    throw new ApiError(409, 'conflict', { reason: 'credential_missing' });
  }
  const source = tools.importSource(row.provider);
  const ciphertext = row.credential_ciphertext;
  const credential = await credentialOperation(() =>
    tools.openCredential({ ciphertext, keyVersion: Number(row.credential_key_version) }, row.id),
  );
  try {
    return await source.listScopeCandidates(credential);
  } catch (err) {
    return importFailure(err, () => new ApiError(409, 'conflict', { reason: 'credential_rejected' }));
  }
}

export const connectionScopeCandidatesOperation = implement(
  connectionScopeCandidates,
  async ({ db, actor, tools, workspace, input }) => {
    const row = await ownConnection(db, actorUserIdOf(actor), workspace.workspaceId, input.connection_id);
    throwIfOwnerGone(row);
    return { candidates: await fetchCandidates(tools, row) };
  },
);

export const connectionScopesSaveOperation = implement(
  connectionScopesSave,
  async ({ db, actor, tools, workspace, input }) => {
    const actorUserId = actorUserIdOf(actor);
    const workspaceId = workspace.workspaceId;
    const organizationId = db.organizationId;
    const row = await ownConnection(db, actorUserId, workspaceId, input.connection_id);
    throwIfOwnerGone(row);
    const source = isImportSourceKind(row.provider) ? tools.importSource(row.provider) : undefined;
    if (source === undefined) throw new ApiError(409, 'conflict', { reason: 'provider_unknown' });

    // 名前は取り込み元の候補から引く。候補に無い ID は断る（画面から送られた名前を保存しない）
    // 範囲を空にする保存は名前を引かないので、取り込み元に問い合わせない（失効した認証情報の接続でも範囲を外せる）
    const found = input.source_ids.length === 0 ? [] : await fetchCandidates(tools, row);
    const candidates = new Map(found.map((candidate) => [candidate.id, candidate]));
    const chosen: ScopeCandidate[] = [];
    const seen = new Set<string>();
    for (const id of input.source_ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const candidate = candidates.get(id);
      if (candidate === undefined) {
        throw new ApiError(400, 'invalid_input', [
          { path: 'source_ids', code: 'scope_unknown', message: '範囲の候補に無い ID' },
        ]);
      }
      chosen.push(candidate);
    }

    const at = now();
    const stamp = at.toISOString();
    const logId = uuidv7(at);
    // 置き換える文は、履歴の行（この要求の ID）があるときだけ動く。履歴は、接続の更新が行を変えたときだけ入る
    const logged = (q: Pick<QueryCreator<Tables>, 'selectFrom'>) =>
      q.selectFrom('change_logs').select('change_logs.id').where('change_logs.id', '=', logId);
    const statements = [
      db.statement((q) =>
        q
          .updateTable('connections')
          .set({
            scope_mode: 'include',
            updated_at: stamp,
            // 範囲が変わるので、次の同期は全部を読む（足した範囲の古い項目は、前回の成功より前に更新されている）
            last_success_at: null,
            sync_state_json: '{}',
          })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('owner_user_id', '=', actorUserId)
          .where('deleted_at', 'is', null)
          // 候補を取っている間に持ち主の離脱や無効化で止まった接続の範囲は書かない（throwIfOwnerGone と同じ条件）
          .where((eb) =>
            eb.or([
              eb('status', '!=', 'stopped'),
              eb.and([
                eb('stopped_reason', 'not in', CONNECTION_OWNER_GONE_REASONS),
                eb.exists(activeMemberName(q, organizationId, workspaceId, actorUserId)),
              ]),
            ]),
          )
          .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(logId).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('connection').as('entity_type'),
                eb.val(row.id).as('entity_id'),
                eb.val('update').as('action'),
                // 前の件数は履歴の文の中で数える（読んでから書くまでの並行する保存で食い違わない）
                eb
                  .fn<string>('json_object', [
                    eb.val('scopes_count'),
                    eb.fn('json_array', [
                      eb
                        .selectFrom('connection_scopes')
                        .select((count) => count.fn.countAll<number>().as('n'))
                        .where('connection_id', '=', row.id),
                      eb.cast(eb.val(chosen.length), 'integer'),
                    ]),
                  ])
                  .as('changes_json'),
                eb.val(stamp).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
      db.statement((q) =>
        q
          .deleteFrom('connection_scopes')
          .where('connection_id', '=', row.id)
          .where((eb) => eb.exists(logged(q))),
      ),
    ];
    // 1行ずつ文にする（上限 200 件）。履歴の行があるときだけ入る
    for (const candidate of chosen) {
      statements.push(
        db.statement((q) =>
          q
            .insertInto('connection_scopes')
            .columns(['connection_id', 'scope_kind', 'source_id', 'source_name'])
            .expression(
              q
                .selectNoFrom((eb) => [
                  eb.val(row.id).as('connection_id'),
                  eb.val(source.scopeKind).as('scope_kind'),
                  eb.val(candidate.id).as('source_id'),
                  eb.val(candidate.name).as('source_name'),
                ])
                .where((eb) => eb.exists(logged(q))),
            ),
        ),
      );
    }
    const results = await db.batch(statements as never);
    if (((results as readonly { changes?: number }[])[0]?.changes ?? 0) === 0) {
      await throwIfClosed(db, workspaceId);
      // 読んだ後に接続が削除されたときは、存在しないときと同じ 404
      throwIfOwnerGone(await ownConnection(db, actorUserId, workspaceId, row.id));
      throw new ApiError(409, 'conflict');
    }
    const [connection] = await readConnections(db, workspaceId, row.id);
    if (connection === undefined) throw new ApiError(404, 'not_found');
    return { connection };
  },
);

// 取り込み元の状態から列への対応と、期限を無視する設定を置き換える。取り込み元には問い合わせない。
// 列は、そのワークスペースの削除していない、完了でない列だけ（完了の列は対応先にしない）。
// 1回の batch() で、接続の更新、変更の履歴、対応の置き換え、期限を無視するときは取り込み済みの取り込み元の期限を空にする（履歴の行があるときだけ動く）
export const connectionMappingSaveOperation = implement(
  connectionMappingSave,
  async ({ db, actor, workspace, input }) => {
    const actorUserId = actorUserIdOf(actor);
    const workspaceId = workspace.workspaceId;
    const organizationId = db.organizationId;
    const row = await ownConnection(db, actorUserId, workspaceId, input.connection_id);

    // 同じ状態名は後の指定を採る
    const byStatus = new Map<string, string>();
    for (const mapping of input.mappings) byStatus.set(mapping.source_status, mapping.column_id);
    const columnIds = [...new Set(byStatus.values())];
    if (columnIds.length > 0) {
      const found = await db.rows(
        db.statement((q) =>
          q
            .selectFrom('board_columns')
            .select(['id', 'is_done'])
            .where('workspace_id', '=', workspaceId)
            .where('deleted_at', 'is', null)
            .where('id', 'in', jsonList(columnIds)),
        ),
      );
      const known = new Map(found.map((column) => [column.id, Number(column.is_done) === 1]));
      for (const id of columnIds) {
        const done = known.get(id);
        if (done === undefined || done) {
          throw new ApiError(400, 'invalid_input', [
            {
              path: 'mappings',
              code: done === undefined ? 'column_unknown' : 'column_done',
              message: done === undefined ? '列が見つからない' : '完了の列は選べない',
            },
          ]);
        }
      }
    }

    const at = now();
    const stamp = at.toISOString();
    const logId = uuidv7(at);
    const logged = (q: Pick<QueryCreator<Tables>, 'selectFrom'>) =>
      q.selectFrom('change_logs').select('change_logs.id').where('change_logs.id', '=', logId);
    const statements = [
      db.statement((q) =>
        q
          .updateTable('connections')
          // 無視をやめる保存では、次の同期で全部を読む（差分では、取り込み元で更新されていない項目の期限が戻らない）
          .set({
            ignore_source_due: input.ignore_source_due ? 1 : 0,
            updated_at: stamp,
            ...(!input.ignore_source_due && Number(row.ignore_source_due) === 1
              ? { last_success_at: null, sync_state_json: '{}' }
              : {}),
          })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('owner_user_id', '=', actorUserId)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
          // 読んだ列が今もすべてある（読んでから書くまでに消えた列を指す対応を書かない）
          .where((eb) =>
            eb(
              eb
                .selectFrom('board_columns as col')
                .select((count) => count.fn.countAll<number>().as('n'))
                .where('col.workspace_id', '=', workspaceId)
                .where('col.deleted_at', 'is', null)
                .where('col.is_done', '=', 0)
                .where('col.id', 'in', jsonList(columnIds)),
              '=',
              columnIds.length,
            ),
          ),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(logId).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('connection').as('entity_type'),
                eb.val(row.id).as('entity_id'),
                eb.val('update').as('action'),
                // 前の値は履歴の文の中で読む（読んでから書くまでの並行する保存で食い違わない）。対応は件数だけ残す
                eb
                  .fn<string>('json_object', [
                    eb.val('status_mappings_count'),
                    eb.fn('json_array', [
                      eb
                        .selectFrom('connection_status_mappings')
                        .select((count) => count.fn.countAll<number>().as('n'))
                        .where('connection_id', '=', row.id),
                      eb.cast(eb.val(byStatus.size), 'integer'),
                    ]),
                    eb.val('ignore_source_due'),
                    eb.fn('json_array', [
                      eb.cast(eb.val(Number(row.ignore_source_due) === 1 ? 1 : 0), 'integer'),
                      eb.cast(eb.val(input.ignore_source_due ? 1 : 0), 'integer'),
                    ]),
                  ])
                  .as('changes_json'),
                eb.val(stamp).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
      db.statement((q) =>
        q
          .deleteFrom('connection_status_mappings')
          .where('connection_id', '=', row.id)
          .where((eb) => eb.exists(logged(q))),
      ),
      ...[...byStatus].map(([sourceStatus, columnId]) =>
        db.statement((q) =>
          q
            .insertInto('connection_status_mappings')
            .columns(['connection_id', 'source_status', 'column_id'])
            .expression(
              q
                .selectNoFrom((eb) => [
                  eb.val(row.id).as('connection_id'),
                  eb.val(sourceStatus).as('source_status'),
                  eb.val(columnId).as('column_id'),
                ])
                .where((eb) => eb.exists(logged(q))),
            ),
        ),
      ),
    ];
    if (input.ignore_source_due) {
      statements.push(
        db.statement((q) =>
          q
            .updateTable('task_sources')
            .set({ source_due_on: null })
            .where('connection_id', '=', row.id)
            .where('workspace_id', '=', workspaceId)
            .where('source_due_on', 'is not', null)
            .where((eb) => eb.exists(logged(q))),
        ),
      );
    }
    const results = await db.batch(statements as never);
    if (((results as readonly { changes?: number }[])[0]?.changes ?? 0) === 0) {
      await throwIfClosed(db, workspaceId);
      await ownConnection(db, actorUserId, workspaceId, row.id);
      throw new ApiError(409, 'conflict');
    }
    const [connection] = await readConnections(db, workspaceId, row.id);
    if (connection === undefined) throw new ApiError(404, 'not_found');
    return { connection };
  },
);

// 「今すぐ同期」。5分に1回の制限は、接続の last_manual_sync_at を条件つきの1文で書いて取り、書けなければ断る
// （同時に押しても、書けるのは1回だけ。書けた1回だけが同期を走らせる）。同期の仕組みの結果は 200 で返す
export const connectionSyncOperation = implement(connectionSync, async ({ db, actor, tools, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const workspaceId = workspace.workspaceId;
  const row = await ownConnection(db, actorUserId, workspaceId, input.connection_id);

  const at = now();
  const stamp = at.toISOString();
  const before = new Date(at.getTime() - CONNECTION_MANUAL_SYNC_INTERVAL_SECONDS * 1000).toISOString();
  const claimed = await db.run(
    db.statement((q) =>
      q
        .updateTable('connections')
        .set({ last_manual_sync_at: stamp })
        .where('id', '=', row.id)
        .where('workspace_id', '=', workspaceId)
        .where('owner_user_id', '=', actorUserId)
        .where('deleted_at', 'is', null)
        .where('status', '!=', 'stopped')
        .where((eb) => eb.or([eb('last_manual_sync_at', 'is', null), eb('last_manual_sync_at', '<=', before)]))
        .where((eb) => eb.exists(openWorkspace(q, db.organizationId, workspaceId))),
    ),
  );
  if (claimed.changes === 0) {
    await throwIfClosed(db, workspaceId);
    // 読んだ後に削除された接続は、存在しないときと同じ 404
    const current = await ownConnection(db, actorUserId, workspaceId, row.id);
    const state = await db.first(
      db.statement((q) =>
        q
          .selectFrom('connections')
          .select('status')
          .where('id', '=', current.id)
          .where('workspace_id', '=', workspaceId),
      ),
    );
    if (state?.status === 'stopped') throw new ApiError(409, 'conflict', { reason: 'connection_stopped' });
    throw new ApiError(429, 'rate_limited');
  }

  const synced = await tools.syncConnection(workspaceId, row.id);
  // 取り込み元に問い合わせなかった結果（範囲が空、止まっている、見つからない）は、5分の枠を使い切らせない。
  // 自分が書いた印のままのときだけ前の値に戻す（取り込み元の不調は問い合わせたので、枠は使い切る）
  if (synced.outcome === 'no_scope' || synced.outcome === 'stopped' || synced.outcome === 'not_found') {
    await db.run(
      db.statement((q) =>
        q
          .updateTable('connections')
          .set({ last_manual_sync_at: row.last_manual_sync_at })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('last_manual_sync_at', '=', stamp),
      ),
    );
  }
  if (synced.outcome === 'not_found') {
    // 錠を取った後に、接続が削除された、持ち主が抜けた、ワークスペースが閉じた
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  const [connection] = await readConnections(db, workspaceId, row.id);
  if (connection === undefined) throw new ApiError(404, 'not_found');
  if (synced.outcome === 'stopped') throw new ApiError(409, 'conflict', { reason: 'connection_stopped' });
  if (synced.outcome === 'no_scope') return { result: 'no_scope' as const, imported: 0, more: false, connection };
  if (synced.outcome === 'success') {
    return { result: 'success' as const, imported: synced.imported, more: synced.more, connection };
  }
  return { result: synced.outcome, imported: synced.imported, more: false, connection };
});

// 止める、消す操作の対象。登録した本人か、ワークスペースのリーダーと管理者だけが触れる。
// 無い（別のワークスペース、別の組織、削除済み）は 404、権限が無ければ 403
async function manageableConnection(
  db: OrganizationDb,
  actor: { userId: string | null; isAdmin: boolean },
  workspace: { workspaceId: string; actorRole: string | null },
  connectionId: string,
) {
  const row = await db.first(
    db.statement((q) =>
      liveConnections(q, workspace.workspaceId)
        .select(['c.id', 'c.owner_user_id', 'c.status', 'c.stopped_reason'])
        .where('c.id', '=', connectionId),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  const actorUserId = actorUserIdOf(actor);
  if (row.owner_user_id !== actorUserId && !isLeaderOrAdmin(actor, workspace)) throw new ApiError(403, 'forbidden');
  return row;
}

// 書く直前に、操作した人が今も本人（今のメンバーか管理者）か、そのワークスペースのリーダーか管理者かを確かめる条件。
// 読んでから書くまでの間に所属や権限を失った人の操作を書かない
function stillMayManage<DB extends Tables, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  q: From,
  organizationId: string,
  workspaceId: string,
  ownedByActor: Expression<SqlBool>,
  actorUserId: string,
) {
  return eb.or([
    eb.and([ownedByActor, ownerStillAllowed(eb, q, organizationId, workspaceId, actorUserId)]),
    eb.exists(
      q
        .selectFrom('users as au')
        .select('au.id')
        .where('au.id', '=', actorUserId)
        .where('au.organization_id', '=', organizationId)
        .where('au.disabled_at', 'is', null)
        .where('au.is_admin', '=', 1),
    ),
    eb.exists(
      q
        .selectFrom('memberships as am')
        .innerJoin('users as amu', 'amu.id', 'am.user_id')
        .select('am.id')
        .where('am.workspace_id', '=', workspaceId)
        .where('am.user_id', '=', actorUserId)
        .where('am.role', '=', 'leader')
        .where('am.left_at', 'is', null)
        .where('amu.organization_id', '=', organizationId)
        .where('amu.disabled_at', 'is', null),
    ),
  ]);
}

export const connectionStopOperation = implement(connectionStop, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const { workspaceId } = workspace;
  const { organizationId } = db;
  const row = await manageableConnection(db, actor, workspace, input.connection_id);
  // 本人が止めたら owner、ほかの人（リーダー、管理者）が止めたら leader
  const reason = row.owner_user_id === actorUserId ? 'owner' : 'leader';
  const at = now();
  const stamp = at.toISOString();
  // 条件は履歴の文と更新の文で同じ。止まっている接続は書き換えない（理由は、止めた最初の理由のまま）
  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          liveConnections(q, workspaceId)
            .where((eb) =>
              eb.and([
                eb('c.id', '=', row.id),
                // 止まっていない接続と、本人が認証情報で再開できる理由で止まった接続を止める（後者は理由を owner か leader に書き換える）
                eb.or([
                  eb('c.status', '!=', 'stopped'),
                  eb('c.stopped_reason', 'in', [...CONNECTION_CREDENTIAL_RESUME_REASONS]),
                ]),
                eb.exists(openWorkspace(q, organizationId, workspaceId)),
                stillMayManage(
                  eb,
                  q,
                  organizationId,
                  workspaceId,
                  eb('c.owner_user_id', '=', actorUserId),
                  actorUserId,
                ),
              ]),
            )
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('connection').as('entity_type'),
              eb.ref('c.id').as('entity_id'),
              eb.val('update').as('action'),
              eb
                .fn<string>('json_object', [
                  eb.val('status'),
                  eb.fn('json_array', [eb.ref('c.status'), eb.val('stopped')]),
                  eb.val('stopped_reason'),
                  eb.fn('json_array', [eb.ref('c.stopped_reason'), eb.val(reason)]),
                ])
                .as('changes_json'),
              eb.val(stamp).as('created_at'),
            ]),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('connections')
        .set({ status: 'stopped', stopped_reason: reason, updated_at: stamp })
        .where('id', '=', row.id)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([eb('status', '!=', 'stopped'), eb('stopped_reason', 'in', [...CONNECTION_CREDENTIAL_RESUME_REASONS])]),
        )
        .where(previousStatementChanged),
    ),
  ] as const);
  if ((results[1]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    // 読んだ後に、別の操作で止まった、消えた、操作した人の権限が変わった。成功として返すのは、別の操作が先に
    // 再開しない停止にしたときだけ。再開できる理由のまま止まっているなら、書けなかったのは権限を失ったため
    const latest = await manageableConnection(db, actor, workspace, row.id);
    if (latest.status !== 'stopped' || resumesOnCredential(latest)) throw new ApiError(403, 'forbidden');
  }
  const [connection] = await readConnections(db, workspaceId, row.id);
  if (connection === undefined) throw new ApiError(404, 'not_found');
  return { connection };
});

export const connectionDeleteOperation = implement(connectionDelete, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const { workspaceId } = workspace;
  const { organizationId } = db;
  const row = await manageableConnection(db, actor, workspace, input.connection_id);
  const at = now();
  const stamp = at.toISOString();
  const results = await db.batch([
    // 履歴を先に置く（消した後では、消す前の表示名と認証情報の有無を読めない）。認証情報の値は入れない
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          liveConnections(q, workspaceId)
            .where((eb) =>
              eb.and([
                eb('c.id', '=', row.id),
                eb.exists(openWorkspace(q, organizationId, workspaceId)),
                stillMayManage(
                  eb,
                  q,
                  organizationId,
                  workspaceId,
                  eb('c.owner_user_id', '=', actorUserId),
                  actorUserId,
                ),
              ]),
            )
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('connection').as('entity_type'),
              eb.ref('c.id').as('entity_id'),
              eb.val('delete').as('action'),
              eb
                .fn<string>('json_patch', [
                  eb.fn<string>('json_object', [eb.val('name'), eb.fn('json_array', [eb.ref('c.name'), eb.val(null)])]),
                  eb
                    .case()
                    .when('c.credential_ciphertext', 'is not', null)
                    .then('{"credential_removed":[null,true]}')
                    .else('{}')
                    .end(),
                ])
                .as('changes_json'),
              eb.val(stamp).as('created_at'),
            ]),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('connections')
        .set({
          deleted_at: stamp,
          updated_at: stamp,
          credential_ciphertext: null,
          credential_key_version: null,
          credential_last4: null,
          sync_state_json: '{}',
          reconcile_state_json: '{}',
          last_success_at: null,
        })
        .where('id', '=', row.id)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where(previousStatementChanged),
    ),
  ] as const);
  if ((results[1]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    // 読んだ後に、別の操作で消えた（404）か、操作した人の権限が変わった
    await manageableConnection(db, actor, workspace, row.id);
    throw new ApiError(403, 'forbidden');
  }
  return { connection_id: row.id };
});
