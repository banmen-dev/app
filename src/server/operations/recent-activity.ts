import {
  RECENT_ACTIVITY_BODY_LENGTH,
  RECENT_ACTIVITY_PAGE_SIZE,
  recentActivity,
  type RecentActivityEntry,
  type RecentActivityEvent,
} from '../../shared/operations/organization/recent-activity.ts';
import { changedColumnsSql, type OrganizationDb } from '../db/index.ts';
import { implement } from './implement.ts';

// 組織のホームの「最近の更新」（recent-activity）。呼んだ人が今所属する、閉じていないワークスペースだけを読む。
// 手順:
//   1. 所属するワークスペース（memberships と workspaces。組織で絞る）を引く
//   2. ワークスペースごとに、change_logs（task、story、epic の行）と comments（消していない行）を、新しい順に 21 件ずつ引く（1回の batch）
//   3. 混ぜて（created_at の降順、同じなら id の降順）、20 件と続きの有無を決める
// ワークスペースごとに文を分けるのは、索引 change_logs_workspace (workspace_id, created_at) と
// comments_workspace_created (workspace_id, created_at, id) を1つの範囲で使い、早く止めるため。
// 1文に workspace_id IN (...) でまとめると、所属するワークスペースの全履歴を読んで並べ替える。
// 対象の題と消したかどうか、した人の名前は、同じ文で tasks、stories、epics、users を結んで引く（どれも組織の中の表。users は組織で絞る）。
// 共通の表は読まない

type Cursor = { created_at: string; id: string };

type ChangeRow = {
  id: string;
  created_at: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_user_id: string | null;
  actor_name: string | null;
  title: string | null;
  fields_json: string;
};
type CommentRow = {
  id: string;
  created_at: string;
  author_user_id: string;
  author_name: string | null;
  task_id: string;
  title: string;
  body: string;
};

const FETCH_LIMIT = RECENT_ACTIVITY_PAGE_SIZE + 1;

// 変更の行。task、story、epic の行だけを出す。権限や配分など、リーダーと管理者だけが見られる行と、コメントの編集と削除の行（comment）は出さない。
// 削除（delete）は出さない: 対象は消えているか（押した先が 404）、削除を取り消した後で、削除の行だけが残っている。
// 消した対象の行は出さない（押した先が 404 になるため）。題は対象の今の題。
// 変えた欄の名前は SQLite が changes_json のキーから取り出し、値は運ばない（本文の値は長い）。changes_json は json_valid の CHECK がある
export function recentChangesStatement(db: OrganizationDb, workspaceId: string, before: Cursor | undefined) {
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .selectFrom('change_logs as cl')
      .leftJoin('tasks as t', (join) =>
        join
          .onRef('t.id', '=', 'cl.entity_id')
          .onRef('t.workspace_id', '=', 'cl.workspace_id')
          .on('cl.entity_type', '=', 'task'),
      )
      .leftJoin('stories as s', (join) =>
        join
          .onRef('s.id', '=', 'cl.entity_id')
          .onRef('s.workspace_id', '=', 'cl.workspace_id')
          .on('cl.entity_type', '=', 'story'),
      )
      .leftJoin('epics as e', (join) =>
        join
          .onRef('e.id', '=', 'cl.entity_id')
          .onRef('e.workspace_id', '=', 'cl.workspace_id')
          .on('cl.entity_type', '=', 'epic'),
      )
      .leftJoin('users as actor', (join) =>
        join.onRef('actor.id', '=', 'cl.actor_user_id').on('actor.organization_id', '=', organizationId),
      )
      .select((eb) => [
        'cl.id',
        'cl.created_at',
        'cl.entity_type',
        'cl.entity_id',
        'cl.action',
        'cl.actor_user_id',
        'actor.name as actor_name',
        eb.fn.coalesce('t.title', 's.title', 'e.title').as('title'),
        changedColumnsSql('cl').as('fields_json'),
      ])
      .where('cl.organization_id', '=', organizationId)
      .where('cl.workspace_id', '=', workspaceId)
      .where('cl.entity_type', 'in', ['task', 'story', 'epic'])
      .where('cl.action', '<>', 'delete')
      .where((eb) =>
        eb.and([
          eb(eb.fn.coalesce('t.id', 's.id', 'e.id'), 'is not', null),
          eb(eb.fn.coalesce('t.deleted_at', 's.deleted_at', 'e.deleted_at'), 'is', null),
        ]),
      )
      .$if(before !== undefined, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('cl.created_at', '<', before!.created_at),
            eb.and([eb('cl.created_at', '=', before!.created_at), eb('cl.id', '<', before!.id)]),
          ]),
        ),
      )
      .orderBy('cl.created_at', 'desc')
      .orderBy('cl.id', 'desc')
      .limit(FETCH_LIMIT),
  );
}

// コメントの行。消していないコメントで、タスクも消していないものだけ（消したコメントは本文が空で、出すものが無い）。
// 本文は先頭の 201 字（コードポイント。SQLite の substr は文字の単位）だけを読み、切ったかは 201 字目で決める（10 万字の本文を運ばない）
export function recentCommentsStatement(db: OrganizationDb, workspaceId: string, before: Cursor | undefined) {
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .selectFrom('comments as c')
      .innerJoin('tasks as t', (join) =>
        join.onRef('t.id', '=', 'c.task_id').onRef('t.workspace_id', '=', 'c.workspace_id'),
      )
      .leftJoin('users as author', (join) =>
        join.onRef('author.id', '=', 'c.author_user_id').on('author.organization_id', '=', organizationId),
      )
      .select((eb) => [
        'c.id',
        'c.created_at',
        'c.author_user_id',
        'author.name as author_name',
        'c.task_id',
        't.title',
        eb.fn<string>('substr', ['c.body_md', eb.val(1), eb.val(RECENT_ACTIVITY_BODY_LENGTH + 1)]).as('body'),
      ])
      .where('c.workspace_id', '=', workspaceId)
      .where('c.deleted_at', 'is', null)
      .where('t.deleted_at', 'is', null)
      .$if(before !== undefined, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('c.created_at', '<', before!.created_at),
            eb.and([eb('c.created_at', '=', before!.created_at), eb('c.id', '<', before!.id)]),
          ]),
        ),
      )
      .orderBy('c.created_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(FETCH_LIMIT),
  );
}

// changes_json のキー（JSON の配列の文字列）。読めなければ空
function fieldsOf(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function changeEvent(action: string, fieldsJson: string): RecentActivityEvent {
  switch (action) {
    case 'create':
      return { kind: 'create' };
    case 'update':
      return { kind: 'update', fields: fieldsOf(fieldsJson) };
    case 'complete':
      return { kind: 'complete' };
    case 'reopen':
      return { kind: 'reopen' };
    default:
      return { kind: 'other' };
  }
}

function actorOf(id: string | null, name: string | null): RecentActivityEntry['actor'] {
  // actor_user_id があっても、組織で絞った users に名前が無ければ（別の組織の人を指す壊れた行）null にする
  return id !== null && name !== null ? { id, name } : null;
}

// 並びは created_at の降順、同じなら id の降順（SQL の ORDER BY と同じ。文字列はコード単位で比べる）
function newer(a: Cursor, b: Cursor): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export const recentActivityOperation = implement(recentActivity, async ({ db, actor, input }) => {
  const userId = actor.userId;
  if (userId === null) return { entries: [], next: null };
  const organizationId = db.organizationId;

  // 所属する閉じていないワークスペース。管理者でも、所属していないワークスペースは読まない
  const workspaces = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['w.id', 'w.name'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', organizationId)
        .where('w.closed_at', 'is', null)
        .orderBy('w.id'),
    ),
  );
  if (workspaces.length === 0) return { entries: [], next: null };

  // 文は、変更（ワークスペースの数だけ）、コメント（同じ数）の順に並べて1回で送る
  const results = await db.batch([
    ...workspaces.map((workspace) => recentChangesStatement(db, workspace.id, input.before)),
    ...workspaces.map((workspace) => recentCommentsStatement(db, workspace.id, input.before)),
  ]);

  const found: RecentActivityEntry[] = [];
  workspaces.forEach((workspace, index) => {
    for (const row of results[index]!.rows as ChangeRow[]) {
      found.push({
        id: row.id,
        created_at: row.created_at,
        actor: actorOf(row.actor_user_id, row.actor_name),
        workspace: { id: workspace.id, name: workspace.name },
        target: { kind: row.entity_type as 'task' | 'story' | 'epic', id: row.entity_id, title: row.title ?? '' },
        event: changeEvent(row.action, row.fields_json),
      });
    }
    for (const row of results[workspaces.length + index]!.rows as CommentRow[]) {
      const chars = Array.from(row.body);
      found.push({
        id: row.id,
        created_at: row.created_at,
        actor: actorOf(row.author_user_id, row.author_name),
        workspace: { id: workspace.id, name: workspace.name },
        target: { kind: 'task', id: row.task_id, title: row.title },
        event: {
          kind: 'comment',
          body: chars.slice(0, RECENT_ACTIVITY_BODY_LENGTH).join(''),
          truncated: chars.length > RECENT_ACTIVITY_BODY_LENGTH,
        },
      });
    }
  });

  found.sort(newer);
  const page = found.slice(0, RECENT_ACTIVITY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    entries: page,
    next:
      found.length > RECENT_ACTIVITY_PAGE_SIZE && last !== undefined
        ? { created_at: last.created_at, id: last.id }
        : null,
  };
});
