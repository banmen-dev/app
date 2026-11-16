import { sql, type RawBuilder } from 'kysely';

// 組織のホームの「最近の更新」（recent-activity）が読む行の条件。部分索引の WHERE と同じ式にする
// （migrations/0035_add_recent_activity_indexes.sql）。SQLite は、問い合わせの条件が索引の条件を含むと示せたときだけ部分索引を使い、
// 束縛の値（?）の入った式からは示せない。そのため、値は束縛せず文字のまま書く（organization-history-filter.ts と同じ）。
// alias は問い合わせで表に付けた別名

// 変更の履歴（change_logs_recent_activity）。タスク、ストーリー、エピックの、削除でない行
export function recentChangeRowFilter(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(${column('entity_type')} IN ('task', 'story', 'epic') AND ${column('action')} <> 'delete')`;
}

// コメント（comments_workspace_created）。本文が空でない行（消していない行。CHECK で deleted_at IS NULL と同じ行になる）
export function recentCommentRowFilter(alias: string): RawBuilder<boolean> {
  return sql<boolean>`${sql.ref(`${alias}.body_md`)} <> ''`;
}

// 「今日やる」の印（today_on）だけを付け外しした update の行。印だけの行は最近の更新に出さない（ほかの欄も一緒に変えた行は出す）。
// 変えた欄が today_on の1つだけ、の行を NOT で外す（索引の条件ではなく、索引の範囲の中で捨てる）。
// 件数は SQL の条件にして、ページの 20 件の数え方が崩れないようにする。
// json_type を先に評価し、today_on を含まない行は json_each を数えない
export function notTodayMarkOnlyRowFilter(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`NOT (${column('action')} = 'update' AND json_type(${column('changes_json')}, '$.today_on') IS NOT NULL AND (SELECT count(*) FROM json_each(${column('changes_json')})) = 1)`;
}
