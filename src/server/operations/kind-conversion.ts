// 種類の変更（task-convert、story-convert、epic-convert）が共通で使う、元と先の対応の読み取りと、書き込みの後ろ半分の文。
// docs/data-model.md の kind_conversions と「書き込みの単位」の「種類の変更」
import { generateKeyBetween } from 'fractional-indexing';
import {
  backlogTasksUnder,
  previousStatementChanged,
  type ExpressionBuilder,
  type OrganizationDb,
  type OrganizationTables,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { changeLogColumns } from './write-guards.ts';

export type ItemKind = 'epic' | 'story' | 'task';

const favoriteColumn = { task: 'task_id', story: 'story_id', epic: 'epic_id' } as const;

// 元の項目から変えた先の種類と ID。ワークスペースで絞る。変えていなければ undefined
export async function convertedToOf(db: OrganizationDb, workspaceId: string, fromKind: ItemKind, fromId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('kind_conversions')
        .select(['kind_conversions.to_kind', 'kind_conversions.to_id'])
        .where('kind_conversions.workspace_id', '=', workspaceId)
        .where('kind_conversions.from_kind', '=', fromKind)
        .where('kind_conversions.from_id', '=', fromId),
    ),
  );
}

// 変えた元の項目の読み取りは 404 のまま、details に先の種類と ID を添える（元の URL から先へ案内し、再送が先の ID を引けるように）
function notFoundAfterConversion(converted: { to_kind: string; to_id: string } | undefined): ApiError {
  return new ApiError(
    404,
    'not_found',
    converted === undefined ? undefined : { converted_to: { kind: converted.to_kind, id: converted.to_id } },
  );
}

// 元を読んで 404 にするとき、変えた元なら先を添えた ApiError。`throw await notFoundOf(...)` で使う
export async function notFoundOf(db: OrganizationDb, workspaceId: string, fromKind: ItemKind, fromId: string) {
  return notFoundAfterConversion(await convertedToOf(db, workspaceId, fromKind, fromId));
}

export type ConversionWrite = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  at: Date;
  convertedAt: string;
  from: { kind: ItemKind; id: string; title: string };
  to: { kind: ItemKind; id: string };
  // 先の作成の履歴の欄（作成と同じ形の [前, 後]）。元の種類と ID（converted_from）はここで足す
  created: Record<string, [null, unknown]>;
};

// 元と先の対応を1行書く文と、お気に入りの付け替え、元の履歴（delete）、先の履歴（create）。
// 対応は直前の文（先の行を作る文）が行を変えたときだけ書き、後ろの3つは元から先を引ける対応の行があるときだけ書く。
// 同時に2回変えても、(workspace_id, from_kind, from_id) の一意で対応は1行になる
export function conversionStatements(db: OrganizationDb, write: ConversionWrite) {
  const { organizationId, workspaceId, actorUserId, at, convertedAt, from, to } = write;
  const convertedRow = <DB, TB extends keyof DB>(builder: ExpressionBuilder<DB, TB>) =>
    (builder as unknown as ExpressionBuilder<OrganizationTables, never>)
      .selectFrom('kind_conversions')
      .select('kind_conversions.id')
      .where('kind_conversions.workspace_id', '=', workspaceId)
      .where('kind_conversions.from_kind', '=', from.kind)
      .where('kind_conversions.from_id', '=', from.id)
      .where('kind_conversions.to_id', '=', to.id);
  const favoriteSet: { task_id?: string | null; story_id?: string | null; epic_id?: string | null } = {};
  favoriteSet[favoriteColumn[from.kind]] = null;
  favoriteSet[favoriteColumn[to.kind]] = to.id;
  return [
    db.statement((q) =>
      q
        .insertInto('kind_conversions')
        .columns(['id', 'workspace_id', 'from_kind', 'from_id', 'to_kind', 'to_id', 'converted_by', 'converted_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(from.kind).as('from_kind'),
              eb.val(from.id).as('from_id'),
              eb.val(to.kind).as('to_kind'),
              eb.val(to.id).as('to_id'),
              eb.val(actorUserId).as('converted_by'),
              eb.val(convertedAt).as('converted_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
    // お気に入りを先へ付け替える。対応が書けたとき（先の行が元から引ける）だけ
    db.statement((q) =>
      q
        .updateTable('favorites')
        .set(favoriteSet)
        .where((eb) =>
          from.kind === 'task'
            ? eb('favorites.task_id', '=', from.id)
            : from.kind === 'story'
              ? eb('favorites.story_id', '=', from.id)
              : eb('favorites.epic_id', '=', from.id),
        )
        .where('favorites.workspace_id', '=', workspaceId)
        .where((eb) => eb.exists(convertedRow(eb))),
    ),
    // 元の履歴（delete。先の種類と ID を添える）。過去の履歴は元の ID に残す
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
              eb.val(actorUserId).as('actor_user_id'),
              eb.val(from.kind).as('entity_type'),
              eb.val(from.id).as('entity_id'),
              eb.val('delete').as('action'),
              eb
                .val(
                  JSON.stringify({
                    deleted_at: [null, convertedAt],
                    converted_to: [null, { id: to.id, kind: to.kind, title: from.title }],
                  }),
                )
                .as('changes_json'),
              eb.val(convertedAt).as('created_at'),
            ])
            .where((eb) => eb.exists(convertedRow(eb))),
        ),
    ),
    // 先の履歴（create。元の種類と ID を添える）
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
              eb.val(actorUserId).as('actor_user_id'),
              eb.val(to.kind).as('entity_type'),
              eb.val(to.id).as('entity_id'),
              eb.val('create').as('action'),
              eb
                .val(
                  JSON.stringify({
                    ...write.created,
                    converted_from: [null, { id: from.id, kind: from.kind, title: from.title }],
                  }),
                )
                .as('changes_json'),
              eb.val(convertedAt).as('created_at'),
            ])
            .where((eb) => eb.exists(convertedRow(eb))),
        ),
    ),
  ] as const;
}

// 行き先の並びの末尾の position。作成と同じく、完了したものも並びに残っているので、含めた末尾に置く。
// ストーリーは epicId の下（null なら親のないストーリー）、タスクは親のないタスク、エピックは最上段
export async function tailPositionOf(
  db: OrganizationDb,
  workspaceId: string,
  kind: ItemKind,
  epicId: string | null = null,
): Promise<string> {
  const last =
    kind === 'task'
      ? await db.first(
          db.statement((q) =>
            backlogTasksUnder(q, workspaceId, null).select('tasks.position').orderBy('tasks.position', 'desc').limit(1),
          ),
        )
      : kind === 'story'
        ? await db.first(
            db.statement((q) =>
              q
                .selectFrom('stories')
                .select('stories.position')
                .where('stories.workspace_id', '=', workspaceId)
                .where('stories.epic_id', epicId === null ? 'is' : '=', epicId)
                .where('stories.deleted_at', 'is', null)
                .orderBy('stories.position', 'desc')
                .orderBy('stories.id', 'desc')
                .limit(1),
            ),
          )
        : await db.first(
            db.statement((q) =>
              q
                .selectFrom('epics')
                .select('epics.position')
                .where('epics.workspace_id', '=', workspaceId)
                .where('epics.deleted_at', 'is', null)
                .orderBy('epics.position', 'desc')
                .limit(1),
            ),
          );
  return generateKeyBetween(last?.position ?? null, null);
}

export type ConvertedItem = {
  id: string;
  workspaceId: string;
  title: string;
  bodyMd: string | null;
  dueOn: string | null;
  linkUrl: string | null;
  categoryId: string | null;
  createdBy: string;
  position: string;
  convertedAt: string;
  // ストーリーを置くエピック（ストーリーのときだけ）。親なしは null
  epicId?: string | null;
};

// 先の行を作る文。書くのは元を論理削除する文が行を変えたときだけ。先のタスクは未着手で、担当、ポイント、スプリントは空。
// エピックの依頼主は作った人（報酬の段階 reward_tier は使わないので書かない。epic-create と同じ）
export function insertConvertedStatement(db: OrganizationDb, kind: ItemKind, item: ConvertedItem) {
  const { id, workspaceId, title, bodyMd, dueOn, linkUrl, categoryId, createdBy, position, convertedAt } = item;
  if (kind === 'story') {
    return db.statement((q) =>
      q
        .insertInto('stories')
        .columns([
          'id',
          'workspace_id',
          'epic_id',
          'title',
          'acceptance_criteria_md',
          'body_md',
          'due_on',
          'link_url',
          'category_id',
          'created_by',
          'position',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(id).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(item.epicId ?? null).as('epic_id'),
              eb.val(title).as('title'),
              eb.val(null).as('acceptance_criteria_md'),
              eb.val(bodyMd).as('body_md'),
              eb.val(dueOn).as('due_on'),
              eb.val(linkUrl).as('link_url'),
              eb.val(categoryId).as('category_id'),
              eb.val(createdBy).as('created_by'),
              eb.val(position).as('position'),
              eb.val(convertedAt).as('created_at'),
              eb.val(convertedAt).as('updated_at'),
            ])
            .where(previousStatementChanged),
        ),
    );
  }
  if (kind === 'epic') {
    return db.statement((q) =>
      q
        .insertInto('epics')
        .columns([
          'id',
          'workspace_id',
          'title',
          'body_md',
          'due_on',
          'link_url',
          'category_id',
          'requester_user_id',
          'created_by',
          'position',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(id).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(title).as('title'),
              eb.val(bodyMd).as('body_md'),
              eb.val(dueOn).as('due_on'),
              eb.val(linkUrl).as('link_url'),
              eb.val(categoryId).as('category_id'),
              eb.val(createdBy).as('requester_user_id'),
              eb.val(createdBy).as('created_by'),
              eb.val(position).as('position'),
              eb.val(convertedAt).as('created_at'),
              eb.val(convertedAt).as('updated_at'),
            ])
            .where(previousStatementChanged),
        ),
    );
  }
  return db.statement((q) =>
    q
      .insertInto('tasks')
      .columns([
        'id',
        'workspace_id',
        'is_imported',
        'tray',
        'title',
        'body_md',
        'due_on',
        'link_url',
        'story_id',
        'category_id',
        'position',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(id).as('id'),
            eb.val(workspaceId).as('workspace_id'),
            eb.val(0).as('is_imported'),
            eb.val('backlog').as('tray'),
            eb.val(title).as('title'),
            eb.val(bodyMd).as('body_md'),
            eb.val(dueOn).as('due_on'),
            eb.val(linkUrl).as('link_url'),
            eb.val(null).as('story_id'),
            eb.val(categoryId).as('category_id'),
            eb.val(position).as('position'),
            eb.val(createdBy).as('created_by'),
            eb.val(convertedAt).as('created_at'),
            eb.val(convertedAt).as('updated_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}
