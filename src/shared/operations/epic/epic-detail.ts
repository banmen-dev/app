import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { definitionRefSchema } from '../definition/definition.ts';

// 人の1行。name は離脱済みの人でも出す。left は、そのワークスペースに今の所属（left_at が空の行）が無いこと
const epicPersonSchema = z.object({ id: z.string(), name: z.string(), left: z.boolean() });

// エピックの画面を開くときに、画面が出すものを1回で読む。閉じたワークスペースでも読める。
// 無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404。
// - requester: 依頼主。離脱済み（left）でも名前を出す（担当の判定と同じ）
// - stories: 配下の削除していないストーリー（position の順。完了したものも含む）。points_done と points_all は、削除していない
//   配下のタスクのポイントの合計（未見積もりは 0。points_done は完了したタスクだけ）で、バックログの木と同じ数え方
// - today と week_start: ワークスペースのタイムゾーンでの今日と週の始まり（0〜6、0 が日曜）。期日の印を決める（backlog-tree と同じ。
//   ブラウザの時計とタイムゾーンに頼らない）
// - can_manage: 呼んだ人が依頼主か、リーダー（管理者を含む）か。クリアの口の出し分けに使う
export const epicDetail = defineOperation({
  name: 'epic-detail',
  description: 'エピックの画面の中身を返す。欄、依頼主、配下のストーリー（完了とポイントつき）、呼んだ人が管理できるか',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
    epic: z.object({
      id: z.string(),
      title: z.string(),
      body_md: z.string().nullable(),
      due_on: z.string().nullable(),
      link_url: z.string().nullable(),
      // 振った区分（削除していないもの）。無ければ null
      category: definitionRefSchema.nullable(),
      // クリアした日時。空なら進行中
      completed_at: z.string().nullable(),
      // 中止は外した（#1435）。前の版の画面の束のために、1版だけ常に null で返す（backlog-tree と同じ）。#1438 で消す
      canceled_at: z.null(),
    }),
    requester: epicPersonSchema,
    stories: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        completed_at: z.string().nullable(),
        points_done: z.number().int(),
        points_all: z.number().int(),
      }),
    ),
    can_manage: z.boolean(),
  }),
});
