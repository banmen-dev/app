import { now } from '../../shared/clock.ts';
import { epicComplete, epicReopen } from '../../shared/operations/epic/index.ts';
import type { EpicClearConflictReason } from '../../shared/operations/epic/epic-clear.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, isLeaderOrAdmin, openWorkspace, throwIfClosed } from './write-guards.ts';

// エピックのクリアと取り消し（docs/data-model.md の epics と「書き込みの単位」）。書き方はストーリーの完了と取り消し
// （story.ts）と同じで、先に読んで断る順を決め、書く文は読んだ値を条件にした UPDATE と、直前の文に結んだ履歴にする。
// 通らなければ読み直して決め直す

type Tables = OrganizationTables;

// 同時の書き込みに負けたときにやり直す回数の上限。超えたら 409 の conflict（changed）
const MAX_ATTEMPTS = 3;

function clearConflict(reason: EpicClearConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 配下の、削除していないストーリー。ワークスペースで必ず絞る
function storiesUnder(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, epicId: string) {
  return from
    .selectFrom('stories')
    .select('stories.id')
    .where('stories.epic_id', '=', epicId)
    .where('stories.workspace_id', '=', workspaceId)
    .where('stories.deleted_at', 'is', null);
}

// 読んだエピックの状態。クリアしたか、依頼主、クリアにした人（履歴の「前」に使う名前）、
// 配下のストーリーの件数と未完了の件数
async function readEpic(db: OrganizationDb, workspaceId: string, epicId: string) {
  const [epicResult, countResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('epics')
        .leftJoin('users as done_by', (join) =>
          join.onRef('done_by.id', '=', 'epics.completed_by').on('done_by.organization_id', '=', db.organizationId),
        )
        .select([
          'epics.requester_user_id',
          'epics.completed_at',
          'epics.completed_by',
          'done_by.name as completed_by_name',
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select((eb) => [eb.fn.countAll<number>().as('total'), eb.fn.count<number>('stories.completed_at').as('done')])
        .where('stories.epic_id', '=', epicId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
  ] as const);
  const row = epicResult.rows[0];
  if (row === undefined) return undefined;
  const total = Number(countResult.rows[0]?.total ?? 0);
  const done = Number(countResult.rows[0]?.done ?? 0);
  return {
    requesterUserId: row.requester_user_id,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    completedByName: row.completed_by_name,
    storyCount: total,
    openCount: total - done,
  };
}

type EpicState = NonNullable<Awaited<ReturnType<typeof readEpic>>>;

// クリアする前に断る順。無い（404）、権限が無い（403）、すでにクリアした（completed）、
// 配下が無い（empty）、未完了が残っている（open_stories）。閉じたワークスペースは、409 を返す前に 409 の workspace_closed にする
async function clearableEpic(
  db: OrganizationDb,
  workspaceId: string,
  epic: EpicState | undefined,
  allowed: (epic: EpicState) => boolean,
): Promise<EpicState> {
  if (epic === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (!allowed(epic)) throw new ApiError(403, 'forbidden');
  if (epic.completedAt !== null) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('completed');
  }
  if (epic.storyCount === 0) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('empty');
  }
  if (epic.openCount > 0) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('open_stories');
  }
  return epic;
}

// クリアする。UPDATE の条件は、同じワークスペースの削除していない、クリアしていないエピック、閉じていないワークスペース、
// 依頼主かリーダー、配下の削除していないストーリーが1件以上あり未完了が無いこと。通らなかったら、読み直して決め直す
export const epicCompleteOperation = implement(epicComplete, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const leader = isLeaderOrAdmin(actor, workspace);

  // 履歴に残す自分の名前
  const user = await db.first(
    db.statement((q) =>
      q.selectFrom('users').select('name').where('id', '=', userId).where('organization_id', '=', organizationId),
    ),
  );
  if (user === undefined) throw new ApiError(404, 'not_found');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await clearableEpic(
      db,
      workspaceId,
      await readEpic(db, workspaceId, epicId),
      (e) => leader || e.requesterUserId === userId,
    );

    const at = now();
    const completedAt = at.toISOString();
    const logId = uuidv7(at);
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          // 中止の列は読まない。マイグレーション（0042）を当ててから版が切り替わるまでに前の版が中止した行でも、
          // 表の CHECK（完了と中止は同時に入らない）に当たらないよう、空に戻す
          .set({
            completed_at: completedAt,
            completed_by: userId,
            canceled_at: null,
            canceled_by: null,
            updated_at: completedAt,
          })
          .where('id', '=', epicId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .$if(!leader, (qb) => qb.where('requester_user_id', '=', userId))
          .where((eb) =>
            eb.and([
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.exists(storiesUnder(q, workspaceId, epicId)),
              eb.not(eb.exists(storiesUnder(q, workspaceId, epicId).where('stories.completed_at', 'is', null))),
            ]),
          ),
      ),
      // 直前の UPDATE が行を変えたときだけ
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
                eb.val(userId).as('actor_user_id'),
                eb.val('epic').as('entity_type'),
                eb.val(epicId).as('entity_id'),
                eb.val('complete').as('action'),
                eb
                  .val(
                    JSON.stringify({
                      completed_at: [null, completedAt],
                      completed_by: [null, { id: userId, name: user.name }],
                    }),
                  )
                  .as('changes_json'),
                eb.val(completedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      return { epic_id: epicId, completed_at: completedAt };
    }
    // 閉じていれば 409 の workspace_closed。そうでなければ読み直して決め直す（上の順）。それでも断る理由が無ければ、やり直す
    await throwIfClosed(db, workspaceId);
  }
  throw clearConflict('changed');
});

// 取り消す前に断る順。無い（404）、権限が無い（403）、クリアしていない（not_completed）
async function reopenableEpic(
  db: OrganizationDb,
  workspaceId: string,
  epic: EpicState | undefined,
  allowed: (epic: EpicState) => boolean,
): Promise<EpicState> {
  if (epic === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (!allowed(epic)) throw new ApiError(403, 'forbidden');
  if (epic.completedAt === null) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('not_completed');
  }
  return epic;
}

export const epicReopenOperation = implement(epicReopen, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const leader = isLeaderOrAdmin(actor, workspace);

  const epic = await reopenableEpic(
    db,
    workspaceId,
    await readEpic(db, workspaceId, epicId),
    (e) => leader || e.requesterUserId === userId,
  );
  const completedAt = epic.completedAt!;

  const at = now();
  const reopenedAt = at.toISOString();
  const logId = uuidv7(at);
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('epics')
        .set({ completed_at: null, completed_by: null, updated_at: reopenedAt })
        .where('id', '=', epicId)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where('completed_at', '=', completedAt)
        .$if(!leader, (qb) => qb.where('requester_user_id', '=', userId))
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
    ),
    // 直前の UPDATE が行を変えたときだけ
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
              eb.val(userId).as('actor_user_id'),
              eb.val('epic').as('entity_type'),
              eb.val(epicId).as('entity_id'),
              eb.val('reopen').as('action'),
              eb
                .val(
                  JSON.stringify({
                    completed_at: [completedAt, null],
                    completed_by: [
                      epic.completedBy === null ? null : { id: epic.completedBy, name: epic.completedByName ?? '' },
                      null,
                    ],
                  }),
                )
                .as('changes_json'),
              eb.val(reopenedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、消えたか、別の要求が先に取り消したか
    // 取り消してからもう一度クリアされた（クリアした日時が変わった）
    await throwIfClosed(db, workspaceId);
    await reopenableEpic(
      db,
      workspaceId,
      await readEpic(db, workspaceId, epicId),
      (e) => leader || e.requesterUserId === userId,
    );
    throw clearConflict('changed');
  }
  return { epic_id: epicId };
});
