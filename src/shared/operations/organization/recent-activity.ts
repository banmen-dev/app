import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 1回に返す件数。続きは next を before に渡して読む
export const RECENT_ACTIVITY_PAGE_SIZE = 20;
// コメントの本文を返す長さの上限（コードポイント）。書記素（国旗、結合文字、ZWJ の絵文字の並び）は割らず、この長さ以内で切る。全文はタスクの詳細で読む
export const RECENT_ACTIVITY_BODY_LENGTH = 200;
// 読むワークスペースの数の上限。今所属する閉じていないワークスペースのうち、新しく作った順（id の降順。UUIDv7）に数える。超えた分は出さない
export const RECENT_ACTIVITY_WORKSPACE_LIMIT = 50;

// 続きの位置。前のページの最後の行の created_at と id。created_at は change_logs と comments に書く形（toISOString の UTC、ミリ秒まで）だけを受け付ける。
// task-history と organization-history のカーソルと同じ形
const cursorSchema = z.object({ created_at: z.iso.datetime({ precision: 3 }), id: idSchema });

// 押すと詳細の引き出しを開く対象。コメントの対象はいつもタスク
export const recentActivityTargetSchema = z.object({
  kind: z.enum(['task', 'story', 'epic']),
  id: z.string(),
  title: z.string(),
});

// 内容。change_logs の action と changes_json の欄の名前から決め、changes_json の値そのものは返さない（task-history と同じ）。
// update の fields は、変えた欄の名前（保存した順）。知らない欄の名前もそのまま返し、画面が「そのほかの欄」にする
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }),
  z.object({ kind: z.literal('update'), fields: z.array(z.string()) }),
  z.object({ kind: z.literal('complete') }),
  z.object({ kind: z.literal('reopen') }),
  // コメント。本文は先頭の RECENT_ACTIVITY_BODY_LENGTH コードポイント以内（書記素を割らない）の平文（Markdown のまま）で、切ったときは truncated が真
  z.object({ kind: z.literal('comment'), body: z.string(), truncated: z.boolean() }),
  // ほかの action（削除の取り消し、外したエピックの中止の過去の行など）
  z.object({ kind: z.literal('other') }),
]);

export const recentActivityEntrySchema = z.object({
  // change_logs か comments の行の ID
  id: z.string(),
  created_at: z.string(),
  // した人（今の名前）。null は同期などの定期処理か運用者の操作、名前を読めない行
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  workspace: z.object({ id: z.string(), name: z.string() }),
  target: recentActivityTargetSchema,
  event: eventSchema,
});

// 組織のホームの「最近の更新」。呼んだ人が今所属する、閉じていないワークスペースの、タスク、ストーリー、エピックの変更（作成、変更、完了、開き直しなど）と、
// 消していないコメントを、created_at と id の新しい順に混ぜて 20 件ずつ返す。続きがあれば next（次に before へ渡す値）を返す。
// 管理者でも、所属していないワークスペースの分は返さない（today と同じ範囲）。消したタスク、ストーリー、エピックに付いた分と、「今日やる」の印だけを付け外しした行は返さない。
// 所属するワークスペースが RECENT_ACTIVITY_WORKSPACE_LIMIT を超えるときは、新しく作った順に上限まで読む。
// 権限や配分など、リーダーと管理者だけが見られる履歴（entity_type が task、story、epic 以外）とコメントの編集と削除の履歴は返さない
export const recentActivity = defineOperation({
  name: 'recent-activity',
  description: `所属する閉じていないワークスペースのタスク、ストーリー、エピックの変更とコメントを新しい順に ${RECENT_ACTIVITY_PAGE_SIZE} 件ずつ返す。変更の値は返さず、コメントは先頭 ${RECENT_ACTIVITY_BODY_LENGTH} コードポイント以内だけ返す`,
  mode: 'read',
  permission: 'organization',
  input: z.object({ before: cursorSchema.optional() }),
  output: z.object({
    entries: z.array(recentActivityEntrySchema),
    next: cursorSchema.nullable(),
  }),
});

export type RecentActivityEntry = z.output<typeof recentActivityEntrySchema>;
export type RecentActivityEvent = z.output<typeof eventSchema>;
