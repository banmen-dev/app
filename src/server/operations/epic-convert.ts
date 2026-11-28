// エピックをストーリーかタスクに変える（epic-convert）。書き方は task-convert と同じ（docs/data-model.md の「書き込みの単位」の「種類の変更」）
import { now } from '../../shared/clock.ts';
import {
  epicConvert,
  type EpicConvertConflictReason,
  type EpicConvertKind,
} from '../../shared/operations/epic/index.ts';
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

// 削除していないエピックと、変えられない理由の元になる事実を読む
async function readSource(db: OrganizationDb, workspaceId: string, epicId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select((eb) => [
          'epics.title',
          'epics.body_md',
          'epics.due_on',
          'epics.link_url',
          'epics.created_by',
          'epics.category_id',
          'epics.completed_at',
          eb
            .exists(
              eb
                .selectFrom('stories')
                .select('stories.id')
                .whereRef('stories.epic_id', '=', 'epics.id')
                .where('stories.workspace_id', '=', workspaceId)
                .where('stories.deleted_at', 'is', null),
            )
            .as('has_children'),
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
  );
}

type Source = NonNullable<Awaited<ReturnType<typeof readSource>>>;

// 変えられない理由。変えられるなら null
export function convertBlockOf(source: Source): EpicConvertConflictReason | null {
  if (source.completed_at !== null) return 'completed';
  if (source.has_children) return 'has_children';
  return null;
}

export const epicConvertOperation = implement(epicConvert, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const kind: EpicConvertKind = input.kind;

  const source = await readSource(db, workspaceId, epicId);
  if (source === undefined) {
    await throwIfClosed(db, workspaceId);
    // 変えた後の再送は、epic-get と同じく、404 に先の種類と ID を添える
    throw await notFoundOf(db, workspaceId, 'epic', epicId);
  }
  // 作った人とリーダー（管理者を含む）だけ。権限は、変えられない理由より先に見る
  if (!mayDeleteOwned(source.created_by, actor, workspace)) throw new ApiError(403, 'forbidden');
  const blocked = convertBlockOf(source);
  if (blocked !== null) throw new ApiError(409, 'conflict', { reason: blocked });

  // 区分は、エピック自身の値。削除された区分は引き継がない
  const categoryId =
    source.category_id === null
      ? null
      : ((await db.first(db.statement((q) => categoryRow(q, workspaceId, source.category_id!).select('categories.id'))))
          ?.id ?? null);
  const category =
    categoryId === null
      ? null
      : await db.first(
          db.statement((q) => categoryRow(q, workspaceId, categoryId).select(['categories.id', 'categories.name'])),
        );

  const position = await tailPositionOf(db, workspaceId, kind);
  const at = now();
  const convertedAt = at.toISOString();
  const newId = uuidv7(at);

  // 先の作成の履歴。作成と同じ形（欄ごとの [前, 後]）
  const created: Record<string, [null, unknown]> = { title: [null, source.title] };
  if (source.body_md !== null) created.body_md = [null, source.body_md];
  if (source.due_on !== null) created.due_on = [null, source.due_on];
  if (source.link_url !== null) created.link_url = [null, source.link_url];
  if (category !== null && category !== undefined) created.category = [null, { id: category.id, name: category.name }];

  const results = await db.batch([
    // 1. 元を、読んだとおりの状態のときだけ論理削除する。読んでから書くまでに、エピックが変わったか、配下のストーリーが付いたか、
    //    クリアしたか、別の要求が先に変えたら 0 行（先の行も対応も書かない）
    db.statement((q) =>
      q
        .updateTable('epics')
        .set({ deleted_at: convertedAt, updated_at: convertedAt })
        .where((eb) =>
          eb.and([
            eb('epics.id', '=', epicId),
            eb('epics.workspace_id', '=', workspaceId),
            eb('epics.deleted_at', 'is', null),
            eb('epics.completed_at', 'is', null),
            eb('epics.title', '=', source.title),
            sameValue('epics.body_md', source.body_md),
            sameValue('epics.due_on', source.due_on),
            sameValue('epics.link_url', source.link_url),
            sameValue('epics.created_by', source.created_by),
            sameValue('epics.category_id', source.category_id),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('stories')
                  .select('stories.id')
                  .whereRef('stories.epic_id', '=', 'epics.id')
                  .where('stories.workspace_id', '=', workspaceId)
                  .where('stories.deleted_at', 'is', null),
              ),
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
      bodyMd: source.body_md,
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
      from: { kind: 'epic', id: epicId, title: source.title },
      to: { kind, id: newId },
      created,
    }),
  ]);

  if ((results[0]?.changes ?? 0) > 0) return { epic_id: epicId, kind, id: newId };

  // 書けなかった。閉じたか、エピックが無いか、別の要求が先に変えた。読み直して理由を返す
  await throwIfClosed(db, workspaceId);
  const current = await readSource(db, workspaceId, epicId);
  if (current === undefined) {
    // 先に変えた（か削除した）要求がある。変えたものなら、対応が残っているので 409（先は1つだけできている）。無ければ 404
    const converted = await convertedToOf(db, workspaceId, 'epic', epicId);
    if (converted === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict', {
      reason: 'changed' satisfies EpicConvertConflictReason,
      converted_to: { kind: converted.to_kind, id: converted.to_id },
    });
  }
  throw new ApiError(409, 'conflict', { reason: convertBlockOf(current) ?? 'changed' });
});
