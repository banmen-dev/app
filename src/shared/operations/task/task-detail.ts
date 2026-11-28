import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { taskFieldValueSchema } from './task-field-set.ts';
import { taskDetailSchema } from './task.ts';

// 詳細の引き出しを開くときに、タスク1件の属性と本文を読む。閉じたワークスペースでも読める。
// 無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404。種類を変えたタスク（task-convert）の 404 は、details に先の種類と ID（converted_to: { kind, id }）を添える。
// fields は、削除していない決まった欄を並びの順に、値（書かれていなければ null）つきで返す。
// today はワークスペースのタイムゾーンでの今日、week_start は週の始まり（0〜6、0 が日曜）。backlog-tree と同じ決め方で、
// 期日の印（過ぎた、今日、今週、それ以外）は、この2つで決める（ブラウザの時計とタイムゾーンに頼らない）
export const taskDetail = defineOperation({
  name: 'task-detail',
  description:
    'タスク1件のタイトル、本文、ポイント、期日、リンク、担当（今所属しているか付き）、完了の状態、削除できるか、決まった欄の値、期日の印を決める今日と週の始まり、列、親のストーリーとエピック、今日やるの印を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  output: z.object({
    task: taskDetailSchema,
    column: z.object({ id: z.string(), name: z.string().nullable(), is_done: z.boolean() }).nullable(),
    story: z.object({ id: z.string(), title: z.string() }).nullable(),
    epic: z.object({ id: z.string(), title: z.string() }).nullable(),
    today_on: z.string().nullable(),
    fields: z.array(taskFieldValueSchema),
    // バックログのタスクか（受信箱とアーカイブでは偽）。引き出しは、今日やるの印と依頼先を直せるかを決めるのに使う
    in_backlog: z.boolean(),
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
  }),
});
