import {
  RECENT_ACTIVITY_BODY_LENGTH,
  RECENT_ACTIVITY_PAGE_SIZE,
  RECENT_ACTIVITY_WORKSPACE_LIMIT,
  recentActivity,
  type RecentActivityEntry,
  type RecentActivityEvent,
} from '../../shared/operations/organization/recent-activity.ts';
import {
  changedColumnsSql,
  notTodayMarkOnlyRowFilter,
  recentChangeRowFilter,
  recentCommentRowFilter,
  type OrganizationDb,
} from '../db/index.ts';
import { implement } from './implement.ts';

// 組織のホームの「最近の更新」（recent-activity）。呼んだ人が今所属する、閉じていないワークスペースだけを読む。
// 手順:
//   1. 所属するワークスペース（memberships と workspaces。組織で絞る）を、新しく作った順（id の降順）に 50 個まで引く
//   2. ワークスペースごとに、change_logs（task、story、epic の行）と comments（消していない行）を、新しい順に 21 件ずつ引く（1回の batch）
//   3. 混ぜて（created_at の降順、同じなら id の降順）、20 件と続きの有無を決める
// ワークスペースごとに文を分けるのは、部分索引 change_logs_recent_activity (workspace_id, created_at, id) と
// comments_workspace_created (workspace_id, created_at, id) を1つの範囲で使い、早く止めるため。
// 1文に workspace_id IN (...) でまとめると、所属するワークスペースの全履歴を読んで並べ替える。
// 対象の題と消したかどうか、した人の名前は、同じ文で tasks、stories、epics、users を結んで引く（どれも組織の中の表。users は組織で絞る）。
// 共通の表は読まない

type Cursor = { created_at: string; id: string };

// 所属するワークスペース（組織で絞って読んだ結果）。文を作る関数はこの形だけを受け取り、入力の ID や別の組織のワークスペースを渡せないようにする
declare const memberWorkspaceBrand: unique symbol;
export type MemberWorkspace = { readonly id: string; readonly name: string; readonly [memberWorkspaceBrand]: true };

type ChangeRow = {
  id: string;
  created_at: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_user_id: string | null;
  actor_name: string | null;
  title: string | null;
  fields_json: string | null;
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
// コメントの本文を、書記素の境目で切るために読む長さ（コードポイント）。上限の 200 より長く読み、1つの書記素（国旗、ZWJ の絵文字、結合文字）を割らない
const BODY_READ_LENGTH = RECENT_ACTIVITY_BODY_LENGTH * 2;

// 呼んだ人が今所属する、閉じていないワークスペース。新しく作った順（id の降順。UUIDv7）に上限まで。管理者でも、所属していないワークスペースは読まない
export async function readMemberWorkspaces(db: OrganizationDb, userId: string): Promise<MemberWorkspace[]> {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['w.id', 'w.name'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .orderBy('w.id', 'desc')
        .limit(RECENT_ACTIVITY_WORKSPACE_LIMIT),
    ),
  );
  return rows as MemberWorkspace[];
}

// 変更の行。task、story、epic の削除でない行だけを読む（条件は部分索引と同じ式 recentChangeRowFilter）。
// 権限や配分などの行（entity_type が上の3つ以外）、コメントの編集と削除の行（comment）、削除の行は出さない。
// 「今日やる」の印だけを付け外しした行は出さない。
// 対象の行が無いもの、消した対象の行は出さない（押した先が 404 になるため）。この絞り込みは索引の範囲の中で行ごとに捨てるので、
// 消した対象の行が続くと、その分だけ長く読む（読む量は消した量に比例する）。題は対象の今の題。
// 変えた欄の名前は SQLite が changes_json のキーから取り出し、値は運ばない（本文の値は長い）。changes_json は json_valid の CHECK がある。
// 続きは (created_at, id) < before。created_at <= を OR の外に AND で足し、索引の範囲に付ける
export function recentChangesStatement(db: OrganizationDb, workspace: MemberWorkspace, before: Cursor | undefined) {
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
      .where('cl.workspace_id', '=', workspace.id)
      .where(recentChangeRowFilter('cl'))
      .where(notTodayMarkOnlyRowFilter('cl'))
      .where((eb) =>
        eb.and([
          eb(eb.fn.coalesce('t.id', 's.id', 'e.id'), 'is not', null),
          eb(eb.fn.coalesce('t.deleted_at', 's.deleted_at', 'e.deleted_at'), 'is', null),
        ]),
      )
      .$if(before !== undefined, (qb) =>
        qb
          .where('cl.created_at', '<=', before!.created_at)
          .where((eb) =>
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

// コメントの行。結ぶ順は CROSS JOIN で固定し（comments を外側に、タスクは主キーで引く。結ぶ条件は WHERE）、部分索引で新しい順に読む。
// INNER JOIN だと、ANALYZE の後に SQLite がタスクを先に走査し、ワークスペースの全タスクのコメントを集めて並べ替える計画を選ぶことがある。
// 消していないコメントで、タスクも消していないものだけ（消したコメントは本文が空で、出すものが無い。
// 条件は部分索引と同じ式 recentCommentRowFilter）。
// 本文は先頭の BODY_READ_LENGTH 字（コードポイント。SQLite の substr は文字の単位）だけを読む（10 万字の本文を運ばない）
export function recentCommentsStatement(db: OrganizationDb, workspace: MemberWorkspace, before: Cursor | undefined) {
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .selectFrom('comments as c')
      .crossJoin('tasks as t')
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
        eb.fn<string>('substr', ['c.body_md', eb.val(1), eb.val(BODY_READ_LENGTH)]).as('body'),
      ])
      .whereRef('t.id', '=', 'c.task_id')
      .whereRef('t.workspace_id', '=', 'c.workspace_id')
      .where('c.workspace_id', '=', workspace.id)
      .where(recentCommentRowFilter('c'))
      .where('c.deleted_at', 'is', null)
      .where('t.deleted_at', 'is', null)
      .$if(before !== undefined, (qb) =>
        qb
          .where('c.created_at', '<=', before!.created_at)
          .where((eb) =>
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

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// 本文の先頭を、200 コードポイント以内で、書記素（国旗、結合文字、ZWJ の絵文字の並び）を割らずに切る。
// 切ったかは、読んだ本文に続きがあるか（200 コードポイントを超えたか）で決める
export function cutBody(text: string): { body: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= RECENT_ACTIVITY_BODY_LENGTH) return { body: text, truncated: false };
  let body = '';
  let length = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = Array.from(segment).length;
    if (length + size > RECENT_ACTIVITY_BODY_LENGTH) break;
    body += segment;
    length += size;
  }
  // 最初の書記素だけで上限を超える（結合文字が延々と続く）ときは、コードポイントで切る
  if (body === '') body = points.slice(0, RECENT_ACTIVITY_BODY_LENGTH).join('');
  return { body, truncated: true };
}

// changes_json のキー（JSON の配列の文字列）。update 以外の行と、読めない値は空
function fieldsOf(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function changeEvent(action: string, fieldsJson: string | null): RecentActivityEvent {
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

// 所属するワークスペースの変更とコメントを読み、新しい順に並べて返す（ワークスペースごとに 21 件まで。ページに切るのは呼ぶ側）。
// 文は、変更（ワークスペースの数だけ）、コメント（同じ数）の順に並べて1回で送る。組織のホームと全組織のダッシュボード（my-recent-activity）が使う
export async function readRecentActivityEntries(
  db: OrganizationDb,
  workspaces: readonly MemberWorkspace[],
  before: Cursor | undefined,
): Promise<RecentActivityEntry[]> {
  if (workspaces.length === 0) return [];
  const results = await db.batch([
    ...workspaces.map((workspace) => recentChangesStatement(db, workspace, before)),
    ...workspaces.map((workspace) => recentCommentsStatement(db, workspace, before)),
  ]);

  const found: RecentActivityEntry[] = [];
  workspaces.forEach((workspace, index) => {
    const workspaceRef = { id: workspace.id, name: workspace.name };
    for (const row of results[index]!.rows as ChangeRow[]) {
      found.push({
        id: row.id,
        created_at: row.created_at,
        actor: actorOf(row.actor_user_id, row.actor_name),
        workspace: workspaceRef,
        target: { kind: row.entity_type as 'task' | 'story' | 'epic', id: row.entity_id, title: row.title ?? '' },
        event: changeEvent(row.action, row.fields_json),
      });
    }
    for (const row of results[workspaces.length + index]!.rows as CommentRow[]) {
      found.push({
        id: row.id,
        created_at: row.created_at,
        actor: actorOf(row.author_user_id, row.author_name),
        workspace: workspaceRef,
        target: { kind: 'task', id: row.task_id, title: row.title },
        event: { kind: 'comment', ...cutBody(row.body) },
      });
    }
  });
  return found.sort(newer);
}

// 新しい順に並べた行から、先頭の 20 件と続きの位置を決める。続きは、21 件目があるときだけ（最後に返した行を次の before にする）
export function pageOfEntries<T extends Cursor>(found: readonly T[]): { entries: T[]; next: Cursor | null } {
  const sorted = [...found].sort(newer);
  const page = sorted.slice(0, RECENT_ACTIVITY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    entries: page,
    next:
      sorted.length > RECENT_ACTIVITY_PAGE_SIZE && last !== undefined
        ? { created_at: last.created_at, id: last.id }
        : null,
  };
}

export const recentActivityOperation = implement(recentActivity, async ({ db, actor, input }) => {
  const userId = actor.userId;
  if (userId === null) return { entries: [], next: null };

  const workspaces = await readMemberWorkspaces(db, userId);
  return pageOfEntries(await readRecentActivityEntries(db, workspaces, input.before));
});
