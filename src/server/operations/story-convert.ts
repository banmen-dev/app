// ストーリーをタスクかエピックに変える（story-convert）。書き方は task-convert と同じ（docs/data-model.md の「書き込みの単位」の「種類の変更」）
import { now } from '../../shared/clock.ts';
import {
  storyConvert,
  type StoryConvertConflictReason,
  type StoryConvertKind,
} from '../../shared/operations/story/index.ts';
import { STORY_TEXT_MAX_LENGTH } from '../../shared/story.ts';
import { sameValue, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { categoryRow } from './definition-refs.ts';
import { implement } from './implement.ts';
import {
  conversionStatements,
  convertedToOf,
  insertConvertedStatement,
  notFoundOf,
  tailPositionOf,
} from './kind-conversion.ts';
import { actorUserIdOf, mayDeleteOwned, openWorkspace, throwIfClosed } from './write-guards.ts';

// 受け入れ基準を本文の末尾に写す見出し
const ACCEPTANCE_HEADING = '## 受け入れ基準';

// 削除していないストーリーと、親のエピック（同じワークスペースの削除していない行だけ）、変えられない理由の元になる事実を読む
async function readSource(db: OrganizationDb, workspaceId: string, storyId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('stories')
        .leftJoin('epics', (join) =>
          join
            .onRef('epics.id', '=', 'stories.epic_id')
            .on('epics.workspace_id', '=', workspaceId)
            .on('epics.deleted_at', 'is', null),
        )
        .select((eb) => [
          'stories.title',
          'stories.acceptance_criteria_md',
          'stories.body_md',
          'stories.due_on',
          'stories.link_url',
          'stories.created_by',
          'stories.category_id',
          'stories.epic_id',
          'stories.completed_at',
          'epics.id as parent_epic_id',
          'epics.category_id as epic_category_id',
          'epics.completed_at as epic_completed_at',
          eb
            .exists(
              eb
                .selectFrom('tasks')
                .select('tasks.id')
                .whereRef('tasks.story_id', '=', 'stories.id')
                .where('tasks.workspace_id', '=', workspaceId)
                .where('tasks.deleted_at', 'is', null),
            )
            .as('has_children'),
        ])
        .where('stories.id', '=', storyId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
  );
}

type Source = NonNullable<Awaited<ReturnType<typeof readSource>>>;

// 先の本文。受け入れ基準があれば、見出しをつけて本文の末尾に写す（本文が空なら見出しから始める）
export function convertedBodyOf(source: Pick<Source, 'body_md' | 'acceptance_criteria_md'>): string | null {
  if (source.acceptance_criteria_md === null) return source.body_md;
  const section = `${ACCEPTANCE_HEADING}\n\n${source.acceptance_criteria_md}`;
  return source.body_md === null ? section : `${source.body_md}\n\n${section}`;
}

// 変えられない理由。変えられるなら null。行き先が何でも、置く先は最上段なので、親のエピックの完了は行き先によらず見る
export function convertBlockOf(source: Source): StoryConvertConflictReason | null {
  if (source.completed_at !== null) return 'completed';
  if (source.has_children) return 'has_children';
  if (source.parent_epic_id !== null && source.epic_completed_at !== null) return 'parent_completed';
  const body = convertedBodyOf(source);
  if (body !== null && [...body].length > STORY_TEXT_MAX_LENGTH) return 'too_long';
  return null;
}

export const storyConvertOperation = implement(storyConvert, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const storyId = input.story_id;
  const kind: StoryConvertKind = input.kind;

  const source = await readSource(db, workspaceId, storyId);
  if (source === undefined) {
    await throwIfClosed(db, workspaceId);
    // 変えた後の再送は、story-get と同じく、404 に先の種類と ID を添える
    throw await notFoundOf(db, workspaceId, 'story', storyId);
  }
  // 作った人とリーダー（管理者を含む）だけ。権限は、変えられない理由より先に見る
  if (!mayDeleteOwned(source.created_by, actor, workspace)) throw new ApiError(403, 'forbidden');
  const blocked = convertBlockOf(source);
  if (blocked !== null) throw new ApiError(409, 'conflict', { reason: blocked });

  // 区分は、親のエピックから引き継いでいた値、無ければストーリー自身の値。削除された区分は引き継がない
  const inheritedCategoryId = source.parent_epic_id !== null ? source.epic_category_id : source.category_id;
  const categoryId =
    inheritedCategoryId === null
      ? null
      : ((await db.first(db.statement((q) => categoryRow(q, workspaceId, inheritedCategoryId).select('categories.id'))))
          ?.id ?? null);
  const category =
    categoryId === null
      ? null
      : await db.first(
          db.statement((q) => categoryRow(q, workspaceId, categoryId).select(['categories.id', 'categories.name'])),
        );

  const body = convertedBodyOf(source);
  const position = await tailPositionOf(db, workspaceId, kind);
  const at = now();
  const convertedAt = at.toISOString();
  const newId = uuidv7(at);

  // 先の作成の履歴。作成と同じ形（欄ごとの [前, 後]）
  const created: Record<string, [null, unknown]> = { title: [null, source.title] };
  if (body !== null) created.body_md = [null, body];
  if (source.due_on !== null) created.due_on = [null, source.due_on];
  if (source.link_url !== null) created.link_url = [null, source.link_url];
  if (category !== null && category !== undefined) created.category = [null, { id: category.id, name: category.name }];

  const results = await db.batch([
    // 1. 元を、読んだとおりの状態のときだけ論理削除する。読んでから書くまでに、ストーリーか親が変わったか、配下のタスクが付いたか、
    //    完了したか、別の要求が先に変えたら 0 行（先の行も対応も書かない）
    db.statement((q) =>
      q
        .updateTable('stories')
        .set({ deleted_at: convertedAt, updated_at: convertedAt })
        .where((eb) =>
          eb.and([
            eb('stories.id', '=', storyId),
            eb('stories.workspace_id', '=', workspaceId),
            eb('stories.deleted_at', 'is', null),
            eb('stories.completed_at', 'is', null),
            eb('stories.title', '=', source.title),
            sameValue('stories.acceptance_criteria_md', source.acceptance_criteria_md),
            sameValue('stories.body_md', source.body_md),
            sameValue('stories.due_on', source.due_on),
            sameValue('stories.link_url', source.link_url),
            sameValue('stories.created_by', source.created_by),
            sameValue('stories.category_id', source.category_id),
            sameValue('stories.epic_id', source.epic_id),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('tasks')
                  .select('tasks.id')
                  .whereRef('tasks.story_id', '=', 'stories.id')
                  .where('tasks.workspace_id', '=', workspaceId)
                  .where('tasks.deleted_at', 'is', null),
              ),
            ),
            // 親のエピックが、読んだときと同じ状態（完了していない。同じ区分。削除されていれば削除されたまま）
            source.epic_id === null
              ? eb.val(true)
              : source.parent_epic_id === null
                ? eb.exists(
                    eb
                      .selectFrom('epics as parent')
                      .select('parent.id')
                      .where('parent.id', '=', source.epic_id)
                      .where('parent.workspace_id', '=', workspaceId)
                      .where('parent.deleted_at', 'is not', null),
                  )
                : eb.exists(
                    eb
                      .selectFrom('epics as parent')
                      .select('parent.id')
                      .where('parent.id', '=', source.parent_epic_id)
                      .where('parent.workspace_id', '=', workspaceId)
                      .where('parent.deleted_at', 'is', null)
                      .where('parent.completed_at', 'is', null)
                      .where(sameValue('parent.category_id', source.epic_category_id)),
                  ),
            // 引き継ぐ区分が、今も振れる（削除されていない）
            categoryId === null
              ? eb.val(true)
              : eb.exists(categoryRow(q, workspaceId, categoryId).select('categories.id')),
          ]),
        ),
    ),
    // 2. 先の行を作る。1 が元を削除したときだけ。作った人は元の作った人
    insertConvertedStatement(db, kind, {
      id: newId,
      workspaceId,
      title: source.title,
      bodyMd: body,
      dueOn: source.due_on,
      linkUrl: source.link_url,
      categoryId,
      createdBy: source.created_by,
      position,
      convertedAt,
    }),
    // 3〜6. 元と先の対応、お気に入りの付け替え、元の履歴（delete）、先の履歴（create）。先の行が書けたときだけ
    ...conversionStatements(db, {
      organizationId,
      workspaceId,
      actorUserId,
      at,
      convertedAt,
      from: { kind: 'story', id: storyId, title: source.title },
      to: { kind, id: newId },
      created,
    }),
  ]);

  if ((results[0]?.changes ?? 0) > 0) return { story_id: storyId, kind, id: newId };

  // 書けなかった。閉じたか、ストーリーが無いか、別の要求が先に変えた。読み直して理由を返す
  await throwIfClosed(db, workspaceId);
  const current = await readSource(db, workspaceId, storyId);
  if (current === undefined) {
    // 先に変えた（か削除した）要求がある。変えたものなら、対応が残っているので 409（先は1つだけできている）。無ければ 404
    const converted = await convertedToOf(db, workspaceId, 'story', storyId);
    if (converted === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict', {
      reason: 'changed' satisfies StoryConvertConflictReason,
      converted_to: { kind: converted.to_kind, id: converted.to_id },
    });
  }
  throw new ApiError(409, 'conflict', { reason: convertBlockOf(current) ?? 'changed' });
});
