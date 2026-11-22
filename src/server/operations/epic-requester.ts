import { now } from '../../shared/clock.ts';
import { epicRequesterUpdate } from '../../shared/operations/epic/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { activeMemberName, actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// エピックの依頼主の変更（docs/data-model.md の epics と「書き込みの単位」）。
// 読んで断る順を決め、書く文は読んだ値を条件にした UPDATE と、
// 直前の文が行を変えたときだけ入れる履歴にする。通らなければ読み直して決め直す

// 同時の書き込みに負けたときにやり直す回数の上限。超えたら読み直し、終わったエピックなら 409 の epic_finished、そうでなければ 409 の conflict
const MAX_ATTEMPTS = 3;

// エピックの現在の欄。同じワークスペースの削除していないもの（クリアと中止も含む）。
// 依頼主の名前は履歴の「前」に使う。組織で絞った users から読む
async function readEpic(db: OrganizationDb, workspaceId: string, epicId: string) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .innerJoin('users as requester', (join) =>
          join
            .onRef('requester.id', '=', 'epics.requester_user_id')
            .on('requester.organization_id', '=', db.organizationId),
        )
        .select([
          'epics.requester_user_id',
          'epics.completed_at',
          'epics.canceled_at',
          'requester.name as requester_name',
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
  );
  if (row === undefined) return undefined;
  return {
    requesterUserId: row.requester_user_id,
    requesterName: row.requester_name,
    finished: row.completed_at !== null || row.canceled_at !== null,
  };
}

// やり直しの回数を使い切ったときに、断る理由を決める。最後の書き込みの直前にエピックが終わっていたら 409 の epic_finished、
// そうでなければ（書き込みの競合に負け続けた）409 の conflict。最後に読み直すだけで、書かない
async function throwIfFinishedOrConflict(db: OrganizationDb, workspaceId: string, epicId: string): Promise<never> {
  const epic = await readEpic(db, workspaceId, epicId);
  if (epic?.finished) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(409, 'epic_finished');
  }
  throw new ApiError(409, 'conflict');
}

// 履歴の1行。直前の文が行を変えたときだけ入れる
function logStatement(
  db: OrganizationDb,
  params: { workspaceId: string; actorUserId: string; epicId: string; at: Date; changes: Record<string, unknown> },
) {
  const { workspaceId, actorUserId, epicId, at, changes } = params;
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns(changeLogColumns)
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(uuidv7(at)).as('id'),
            eb.val(organizationId).as('organization_id'),
            eb.val(workspaceId).as('workspace_id'),
            eb.val(actorUserId).as('actor_user_id'),
            eb.val('epic').as('entity_type'),
            eb.val(epicId).as('entity_id'),
            eb.val('update').as('action'),
            eb.val(JSON.stringify(changes)).as('changes_json'),
            eb.val(at.toISOString()).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}

// リーダー（管理者を含む）でない人（依頼主も）は、権限の種類 leader が登録の関数で 403 にする。
// 読んで断る順は、エピックが無い（404）、替え先が入れる人でない（404）、終わったエピック（409）。今と同じ依頼主なら何も書かない（閉じたワークスペースは断る）。
// 書く文の条件は、同じワークスペースの進行中のエピック、閉じていないワークスペース、読んだ依頼主のまま、替え先が入れる人であること。
// 通らなかったら、閉じていれば 409 の workspace_closed、そうでなければ読み直して上の順で決め直す
export const epicRequesterUpdateOperation = implement(epicRequesterUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const userId = input.user_id;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const epic = await readEpic(db, workspaceId, epicId);
    const active = await db.first(db.statement((q) => activeMemberName(q, organizationId, workspaceId, userId)));
    if (epic === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (active === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (epic.finished) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'epic_finished');
    }
    const requester = { id: userId, name: active.name, left: false };
    if (epic.requesterUserId === userId) {
      // 同じ依頼主なら何も書かない。書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { changed: false, requester };
    }

    const at = now();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ requester_user_id: userId, updated_at: at.toISOString() })
          .where('id', '=', epicId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .where('canceled_at', 'is', null)
          // 読んだ依頼主のまま（履歴の「前」がずれないように）
          .where('requester_user_id', '=', epic.requesterUserId)
          .where((eb) =>
            eb.and([
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.exists(activeMemberName(q, organizationId, workspaceId, userId)),
            ]),
          ),
      ),
      logStatement(db, {
        workspaceId,
        actorUserId,
        epicId,
        at,
        changes: {
          requester: [
            { id: epic.requesterUserId, name: epic.requesterName },
            { id: userId, name: active.name },
          ],
        },
      }),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { changed: true, requester };
    await throwIfClosed(db, workspaceId);
  }
  return throwIfFinishedOrConflict(db, workspaceId, epicId);
});
