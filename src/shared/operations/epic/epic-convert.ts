import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 変えた先の種類。エピックはストーリーかタスクに変えられる
export const epicConvertKinds = ['story', 'task'] as const;
export type EpicConvertKind = (typeof epicConvertKinds)[number];

// エピックの種類の変更を 409 の conflict で断った理由（details.reason）。
// completed はクリア済み、has_children は配下に削除していないストーリーがある（完了したものも数える）、
// changed は読んでから書くまでに別の要求がエピックを変えた（先に変えた要求があったことを含む）
export const epicConvertConflictReasons = ['completed', 'has_children', 'changed'] as const;
export type EpicConvertConflictReason = (typeof epicConvertConflictReasons)[number];

export function epicConvertConflictReasonOf(details: unknown): EpicConvertConflictReason | undefined {
  return conflictReasonOf(details, epicConvertConflictReasons);
}

// エピックを、ストーリーかタスクに変える。行き先の表に作り直し、元のエピックは論理削除する（ID と URL が変わる）。
// 引き継ぐのは、題、本文、期日、リンク、作った人、区分。報酬の段階と依頼主は引き継がない。先のタスクは未着手で、担当とポイントは空。
// 位置は最上段（親なし）の末尾（ストーリーなら親のないストーリーの末尾、タスクなら親のないタスクの末尾）。
// 元と先の対応（kind_conversions）、お気に入りの付け替え、変更の履歴（元に delete、先に create）を同時に書く。
// 変えられるのは、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404。権限より先に、存在で決める。
// 変えた後の再送は 404 のまま、details に先の種類と ID（converted_to: { kind, id }）を添える。
// 同時に届いて負けた側は 409（reason は changed）で、同じ converted_to を添える。
// 断る理由は epicConvertConflictReasons。何も書かれない
export const epicConvert = defineOperation({
  name: 'epic-convert',
  description:
    'エピックをストーリーかタスクに変える（行き先に作り直し、元は削除する）。作った人とリーダー（管理者を含む）だけが変えられる。配下にストーリーがある、クリア済みのエピックは変えられない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema, kind: z.enum(epicConvertKinds) }),
  output: z.object({ epic_id: z.string(), kind: z.enum(epicConvertKinds), id: z.string() }),
});
