import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 変えた先の種類。タスクはストーリーかエピックに変えられる
export const taskConvertKinds = ['story', 'epic'] as const;
export type TaskConvertKind = (typeof taskConvertKinds)[number];

// タスクの種類の変更を 409 の conflict で断った理由（details.reason）。
// completed は完了している、in_sprint はスプリントに入っている、imported は取り込んだタスク、
// has_comments は削除していないコメントがある、has_attachments は添付がある、has_field_values は削除していない決まった欄に値がある（削除した欄の値は数えず、元の行に残り先へ運ばれない）、
// parent_completed は置く先のエピックが完了している（ストーリーに変えるときだけ）、
// changed は読んでから書くまでに別の要求がタスクか置く先を変えた（先に変えた要求があったことを含む）
export const taskConvertConflictReasons = [
  'completed',
  'in_sprint',
  'imported',
  'has_comments',
  'has_attachments',
  'has_field_values',
  'parent_completed',
  'changed',
] as const;
export type TaskConvertConflictReason = (typeof taskConvertConflictReasons)[number];

export function taskConvertConflictReasonOf(details: unknown): TaskConvertConflictReason | undefined {
  return conflictReasonOf(details, taskConvertConflictReasons);
}

// タスクを、ストーリーかエピックに変える。行き先の表に作り直し、元のタスクは論理削除する（ID と URL が変わる）。
// 引き継ぐのは、題、本文、期日、リンク、作った人、区分（親から引き継いでいた値）。ポイント、担当、依頼先、リポジトリ、今日やるの印は引き継がない。
// 位置は、ストーリーなら元の親のストーリーが入っていたエピックの下の末尾（親なしなら親のないストーリーの末尾）、エピックなら最上段の末尾。
// 元と先の対応（kind_conversions）、お気に入りの付け替え、変更の履歴（元に delete、先に create）を同時に書く。
// 変えられるのは、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404。権限より先に、存在で決める。
// 断る理由は taskConvertConflictReasons。何も書かれない
export const taskConvert = defineOperation({
  name: 'task-convert',
  description:
    'タスクをストーリーかエピックに変える（行き先に作り直し、元は削除する）。作った人とリーダー（管理者を含む）だけが変えられる。完了、スプリントに入っている、取り込んだ、コメントか添付か削除していない決まった欄の値がある（削除した欄の値は元の行に残り先へ運ばれない）、置く先のエピックが完了しているタスクは変えられない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema, kind: z.enum(taskConvertKinds) }),
  output: z.object({ task_id: z.string(), kind: z.enum(taskConvertKinds), id: z.string() }),
});
