// いなくなった人の接続を止める文（Issue #1546）。ワークスペースからの離脱（membership-leave）は、そのワークスペースのその人の接続を
// member_left で止め、ユーザーの無効化（user-disable）は、組織のすべてのワークスペースのその人の接続を user_disabled で止めて
// 認証情報の列を消す。どちらも呼ぶ操作の batch() に、履歴の文と接続の文の2つを足す（件数によらず文の数は決まっている）。
// 既に止まっている接続の停止の理由は書き換えない（無効化でも認証情報だけは消す）。削除した接続は認証情報が既に空なので触らない
import {
  uuidv7Sql,
  type Expression,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { changeLogColumns } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

export type DepartedConnections = {
  actorUserId: string;
  ownerUserId: string;
  at: Date;
  reason: 'member_left' | 'user_disabled';
  // そのワークスペースの接続だけを止める。無ければ、組織のすべてのワークスペース（閉じたもの、論理削除したものを含む。
  // 認証情報を DB に残さないため）の接続を止める
  workspaceId?: string;
  // 認証情報の列（暗号文、鍵の版、末尾4文字）と、認証情報に結んだ同期と照合の続きの位置を消す
  removeCredential: boolean;
  // この要求で書いた（所属が終わった、無効になった）ことの見方。それが返す行があるときだけ動く
  writtenHere: (from: From) => Expression<unknown>;
};

// 履歴を先に置く（止めた後では、止める前の状態と認証情報の有無を読めない）
export function stopDepartedConnectionStatements(db: OrganizationDb, options: DepartedConnections) {
  const { actorUserId, ownerUserId, at, reason, workspaceId, removeCredential, writtenHere } = options;
  const organizationId = db.organizationId;
  const stamp = at.toISOString();

  // 組織のワークスペース。接続の表は組織の列を持たないので、ワークスペースで組織に絞る
  const organizationWorkspaces = (from: From) => {
    const rows = from.selectFrom('workspaces as cw').select('cw.id').where('cw.organization_id', '=', organizationId);
    return workspaceId === undefined ? rows : rows.where('cw.id', '=', workspaceId);
  };

  const log = db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns(changeLogColumns)
      .expression(
        q
          .selectFrom('connections as c')
          .select((eb) => [
            uuidv7Sql(at).as('id'),
            eb.val(organizationId).as('organization_id'),
            eb.ref('c.workspace_id').as('workspace_id'),
            eb.val(actorUserId).as('actor_user_id'),
            eb.val('connection').as('entity_type'),
            eb.ref('c.id').as('entity_id'),
            eb.val('update').as('action'),
            // 止めた接続は {"status": [前, "stopped"], "stopped_reason": [前, 理由]}、認証情報を消したら "credential_removed": [null, true]。
            // 認証情報の値は入れない
            eb
              .fn<string>('json_patch', [
                eb
                  .case()
                  .when('c.status', '!=', 'stopped')
                  .then(
                    eb.fn<string>('json_object', [
                      eb.val('status'),
                      eb.fn('json_array', [eb.ref('c.status'), eb.val('stopped')]),
                      eb.val('stopped_reason'),
                      eb.fn('json_array', [eb.ref('c.stopped_reason'), eb.val(reason)]),
                    ]),
                  )
                  .else('{}')
                  .end(),
                removeCredential
                  ? eb
                      .case()
                      .when('c.credential_ciphertext', 'is not', null)
                      .then('{"credential_removed":[null,true]}')
                      .else('{}')
                      .end()
                  : eb.val('{}'),
              ])
              .as('changes_json'),
            eb.val(stamp).as('created_at'),
          ])
          .where('c.owner_user_id', '=', ownerUserId)
          .where('c.deleted_at', 'is', null)
          .where('c.workspace_id', 'in', organizationWorkspaces(q))
          .where((eb) =>
            eb.or([
              eb('c.status', '!=', 'stopped'),
              ...(removeCredential ? [eb('c.credential_ciphertext', 'is not', null)] : []),
            ]),
          )
          .where((eb) => eb.exists(writtenHere(q))),
      ),
  );

  // 条件は履歴の文と同じ。SET の式は書き換える前の値を読むので、止まっていた接続の理由はそのまま残る
  const stop = db.statement((q) =>
    q
      .updateTable('connections')
      .set((eb) => ({
        status: 'stopped',
        stopped_reason: eb.case().when('status', '=', 'stopped').then(eb.ref('stopped_reason')).else(reason).end(),
        updated_at: stamp,
        ...(removeCredential
          ? {
              credential_ciphertext: null,
              credential_key_version: null,
              credential_last4: null,
              sync_state_json: '{}',
              reconcile_state_json: '{}',
            }
          : {}),
      }))
      .where((eb) =>
        eb.and([
          eb('owner_user_id', '=', ownerUserId),
          eb('deleted_at', 'is', null),
          eb('workspace_id', 'in', organizationWorkspaces(q)),
          eb.or([
            eb('status', '!=', 'stopped'),
            ...(removeCredential ? [eb('credential_ciphertext', 'is not', null)] : []),
          ]),
          eb.exists(writtenHere(q)),
        ]),
      ),
  );

  return [log, stop] as const;
}
