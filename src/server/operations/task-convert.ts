// タスクをストーリーかエピックに変える（task-convert）。docs/data-model.md の「書き込みの単位」の「種類の変更」
import { now } from '../../shared/clock.ts';
import {
  taskConvert,
  type TaskConvertConflictReason,
  type TaskConvertKind,
} from '../../shared/operations/task/index.ts';
import { sameValue, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import {
  conversionStatements,
  convertedToOf,
  insertConvertedStatement,
  notFoundOf,
  tailPositionOf,
} from './kind-conversion.ts';
import { categoryRow } from './definition-refs.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, mayDeleteOwned, openWorkspace, throwIfClosed } from './write-guards.ts';

// 削除していないタスクと、親のストーリー、その親のエピック（どちらも同じワークスペースの削除していない行だけ）、変えられない理由の元になる事実を読む
async function readSource(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('stories', (join) =>
          join
            .onRef('stories.id', '=', 'tasks.story_id')
            .on('stories.workspace_id', '=', workspaceId)
            .on('stories.deleted_at', 'is', null),
        )
        .leftJoin('epics', (join) =>
          join
            .onRef('epics.id', '=', 'stories.epic_id')
            .on('epics.workspace_id', '=', workspaceId)
            .on('epics.deleted_at', 'is', null),
        )
        .select((eb) => [
          'tasks.title',
          'tasks.body_md',
          'tasks.due_on',
          'tasks.link_url',
          'tasks.created_by',
          'tasks.category_id',
          'tasks.story_id',
          'tasks.is_imported',
          'tasks.sprint_id',
          'tasks.completed_at',
          'stories.id as parent_story_id',
          'stories.category_id as story_category_id',
          'epics.id as epic_id',
          'epics.title as epic_title',
          'epics.category_id as epic_category_id',
          'epics.completed_at as epic_completed_at',
          eb
            .exists(
              eb
                .selectFrom('comments')
                .select('comments.id')
                .whereRef('comments.task_id', '=', 'tasks.id')
                .where('comments.workspace_id', '=', workspaceId)
                .where('comments.deleted_at', 'is', null),
            )
            .as('has_comments'),
          eb
            .exists(
              eb
                .selectFrom('attachments')
                .select('attachments.id')
                .whereRef('attachments.task_id', '=', 'tasks.id')
                .where('attachments.workspace_id', '=', workspaceId)
                .where('attachments.attached_at', 'is not', null),
            )
            .as('has_attachments'),
          eb
            .exists(
              eb
                .selectFrom('task_field_values')
                .innerJoin('detail_fields', 'detail_fields.id', 'task_field_values.field_id')
                .select('task_field_values.task_id')
                .whereRef('task_field_values.task_id', '=', 'tasks.id')
                .where('detail_fields.workspace_id', '=', workspaceId)
                .where('detail_fields.deleted_at', 'is', null),
            )
            .as('has_field_values'),
        ])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.deleted_at', 'is', null),
    ),
  );
}

type Source = NonNullable<Awaited<ReturnType<typeof readSource>>>;

// 変えられない理由。変えられるなら null。行き先がエピックなら、置く先のエピックの完了は見ない（最上段に置く）
export function convertBlockOf(source: Source, kind: TaskConvertKind): TaskConvertConflictReason | null {
  if (source.completed_at !== null) return 'completed';
  if (source.is_imported === 1) return 'imported';
  if (source.sprint_id !== null) return 'in_sprint';
  if (source.has_comments) return 'has_comments';
  if (source.has_attachments) return 'has_attachments';
  if (source.has_field_values) return 'has_field_values';
  if (kind === 'story' && source.epic_id !== null && source.epic_completed_at !== null) return 'parent_completed';
  return null;
}

export const taskConvertOperation = implement(taskConvert, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;
  const kind = input.kind;

  const source = await readSource(db, workspaceId, taskId);
  if (source === undefined) {
    await throwIfClosed(db, workspaceId);
    // 変えた後の再送は、task-detail と同じく、404 に先の種類と ID を添える（応答だけが落ちたときに先の ID を引ける）
    throw await notFoundOf(db, workspaceId, 'task', taskId);
  }
  // 作った人とリーダー（管理者を含む）だけ。権限は、変えられない理由より先に見る
  if (!mayDeleteOwned(source.created_by, actor, workspace)) throw new ApiError(403, 'forbidden');
  const blocked = convertBlockOf(source, kind);
  if (blocked !== null) throw new ApiError(409, 'conflict', { reason: blocked });

  // 区分は、親から引き継いでいた値（エピック、ストーリー、タスク自身の順に最初に入っているもの）。削除された区分は引き継がない。
  // ストーリーをエピックの下に置くときは、区分を親から引き継ぐ（親のあるストーリーは区分を持たない）
  const inheritedCategoryId = source.epic_category_id ?? source.story_category_id ?? source.category_id;
  const categoryId =
    (kind === 'story' && source.epic_id !== null) || inheritedCategoryId === null
      ? null
      : ((await db.first(db.statement((q) => categoryRow(q, workspaceId, inheritedCategoryId).select('categories.id'))))
          ?.id ?? null);

  const parentEpicId = kind === 'story' ? source.epic_id : null;
  // 位置は行き先の並びの末尾（作成と同じ。完了したものも並びに残っているので、含めた末尾に置く）
  const position = await tailPositionOf(db, workspaceId, kind, parentEpicId);

  const at = now();
  const convertedAt = at.toISOString();
  const newId = uuidv7(at);
  const createdBy = source.created_by ?? actorUserId;

  // 先の作成の履歴。作成と同じ形（欄ごとの [前, 後]）に、元のタスクを添える
  const category =
    categoryId === null
      ? null
      : await db.first(
          db.statement((q) => categoryRow(q, workspaceId, categoryId).select(['categories.id', 'categories.name'])),
        );
  const created: Record<string, [null, unknown]> = { title: [null, source.title] };
  if (source.body_md !== null) created.body_md = [null, source.body_md];
  if (source.due_on !== null) created.due_on = [null, source.due_on];
  if (source.link_url !== null) created.link_url = [null, source.link_url];
  if (category !== null && category !== undefined) created.category = [null, { id: category.id, name: category.name }];
  if (parentEpicId !== null) created.epic = [null, { id: parentEpicId, title: source.epic_title ?? '' }];

  const results = await db.batch([
    // 1. 元を、読んだとおりの状態のときだけ論理削除する。読んでから書くまでに、タスクか親か区分が変わったか、コメント、添付、決まった欄の値、
    //    スプリントが付いたか、完了したか、別の要求が先に変えたら 0 行（先の行も対応も書かない）
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ deleted_at: convertedAt, updated_at: convertedAt, today_on: null })
        .where((eb) =>
          eb.and([
            eb('tasks.id', '=', taskId),
            eb('tasks.workspace_id', '=', workspaceId),
            eb('tasks.deleted_at', 'is', null),
            eb('tasks.completed_at', 'is', null),
            eb('tasks.is_imported', '=', 0),
            eb('tasks.sprint_id', 'is', null),
            eb('tasks.title', '=', source.title),
            sameValue('tasks.body_md', source.body_md),
            sameValue('tasks.due_on', source.due_on),
            sameValue('tasks.link_url', source.link_url),
            sameValue('tasks.created_by', source.created_by),
            sameValue('tasks.category_id', source.category_id),
            sameValue('tasks.story_id', source.story_id),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('comments')
                  .select('comments.id')
                  .whereRef('comments.task_id', '=', 'tasks.id')
                  .where('comments.deleted_at', 'is', null),
              ),
            ),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('attachments')
                  .select('attachments.id')
                  .whereRef('attachments.task_id', '=', 'tasks.id')
                  .where('attachments.attached_at', 'is not', null),
              ),
            ),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('task_field_values')
                  .innerJoin('detail_fields', 'detail_fields.id', 'task_field_values.field_id')
                  .select('task_field_values.task_id')
                  .whereRef('task_field_values.task_id', '=', 'tasks.id')
                  .where('detail_fields.workspace_id', '=', workspaceId)
                  .where('detail_fields.deleted_at', 'is', null),
              ),
            ),
            // 親のストーリーが、読んだときと同じ状態（同じエピックの下、同じ区分。削除されていれば削除されたまま）
            source.story_id === null
              ? eb.val(true)
              : source.parent_story_id === null
                ? eb.exists(
                    eb
                      .selectFrom('stories as parent')
                      .select('parent.id')
                      .where('parent.id', '=', source.story_id)
                      .where('parent.workspace_id', '=', workspaceId)
                      .where('parent.deleted_at', 'is not', null),
                  )
                : eb.exists(
                    eb
                      .selectFrom('stories as parent')
                      .select('parent.id')
                      .where('parent.id', '=', source.parent_story_id)
                      .where('parent.workspace_id', '=', workspaceId)
                      .where('parent.deleted_at', 'is', null)
                      .where(sameValue('parent.epic_id', source.epic_id))
                      .where(sameValue('parent.category_id', source.story_category_id)),
                  ),
            // 親のエピックが、読んだときと同じ状態（同じ区分。ストーリーに変えるときは完了していない）
            source.epic_id === null
              ? eb.val(true)
              : eb.exists(
                  eb
                    .selectFrom('epics as grand')
                    .select('grand.id')
                    .where('grand.id', '=', source.epic_id)
                    .where('grand.workspace_id', '=', workspaceId)
                    .where('grand.deleted_at', 'is', null)
                    .where(sameValue('grand.category_id', source.epic_category_id))
                    .$if(kind === 'story', (qb) => qb.where('grand.completed_at', 'is', null)),
                ),
            // 引き継ぐ区分が、今も振れる（削除されていない）
            categoryId === null
              ? eb.val(true)
              : eb.exists(categoryRow(q, workspaceId, categoryId).select('categories.id')),
          ]),
        ),
    ),
    // 2. 先の行を作る。1 が元を削除したときだけ
    insertConvertedStatement(db, kind, {
      id: newId,
      workspaceId,
      title: source.title,
      bodyMd: source.body_md,
      dueOn: source.due_on,
      linkUrl: source.link_url,
      categoryId,
      createdBy,
      position,
      convertedAt,
      epicId: parentEpicId,
    }),
    // 3〜6. 元と先の対応、お気に入りの付け替え、元の履歴（delete）、先の履歴（create）。先の行が書けたときだけ
    ...conversionStatements(db, {
      organizationId,
      workspaceId,
      actorUserId,
      at,
      convertedAt,
      from: { kind: 'task', id: taskId, title: source.title },
      to: { kind, id: newId },
      created,
    }),
  ]);

  if ((results[0]?.changes ?? 0) > 0) return { task_id: taskId, kind, id: newId };

  // 書けなかった。閉じたか、タスクが無いか、別の要求が先に変えた。読み直して理由を返す
  await throwIfClosed(db, workspaceId);
  const current = await readSource(db, workspaceId, taskId);
  if (current === undefined) {
    // 先に変えた（か削除した）要求がある。変えたものなら、対応が残っているので 409（先は1つだけできている）。無ければ 404
    const converted = await convertedToOf(db, workspaceId, 'task', taskId);
    if (converted === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict', {
      reason: 'changed' satisfies TaskConvertConflictReason,
      converted_to: { kind: converted.to_kind, id: converted.to_id },
    });
  }
  throw new ApiError(409, 'conflict', { reason: convertBlockOf(current, kind) ?? 'changed' });
});
