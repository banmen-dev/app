import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 変えた先の種類。ストーリーはタスクかエピックに変えられる
export const storyConvertKinds = ['task', 'epic'] as const;
export type StoryConvertKind = (typeof storyConvertKinds)[number];

// ストーリーの種類の変更を 409 の conflict で断った理由（details.reason）。
// completed は完了している、has_children は配下に削除していないタスクがある（完了したものも数える）、
// parent_completed は親のエピックが完了している（完了したエピックの下のストーリーは親を変えられない）、
// too_long は受け入れ基準を本文の末尾に写すと本文の上限（1 万字）を超える、
// changed は読んでから書くまでに別の要求がストーリーか親を変えた（先に変えた要求があったことを含む）
export const storyConvertConflictReasons = [
  'completed',
  'has_children',
  'parent_completed',
  'too_long',
  'changed',
] as const;
export type StoryConvertConflictReason = (typeof storyConvertConflictReasons)[number];

export function storyConvertConflictReasonOf(details: unknown): StoryConvertConflictReason | undefined {
  return conflictReasonOf(details, storyConvertConflictReasons);
}

// ストーリーを、タスクかエピックに変える。行き先の表に作り直し、元のストーリーは論理削除する（ID と URL が変わる）。
// 引き継ぐのは、題、本文、期日、リンク、作った人、区分（親のエピックから引き継いでいた値）。受け入れ基準は、先の本文の末尾に
// 見出し（## 受け入れ基準）つきで写す（本文が空なら見出しから始める）。先のタスクは未着手で、担当とポイントは空。
// 位置は最上段（親なし）の末尾（タスクなら親のないタスクの末尾、エピックならエピックの末尾）。
// 元と先の対応（kind_conversions）、お気に入りの付け替え、変更の履歴（元に delete、先に create）を同時に書く。
// 変えられるのは、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 無いストーリー（別の組織・別のワークスペース・削除済みを含む）は 404。権限より先に、存在で決める。
// 変えた後の再送は 404 のまま、details に先の種類と ID（converted_to: { kind, id }）を添える。
// 同時に届いて負けた側は 409（reason は changed）で、同じ converted_to を添える。
// 断る理由は storyConvertConflictReasons。何も書かれない
export const storyConvert = defineOperation({
  name: 'story-convert',
  description:
    'ストーリーをタスクかエピックに変える（行き先に作り直し、元は削除する。受け入れ基準は本文の末尾に写す）。作った人とリーダー（管理者を含む）だけが変えられる。配下にタスクがある、完了している、親のエピックが完了している、写すと本文が上限を超えるストーリーは変えられない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, story_id: idSchema, kind: z.enum(storyConvertKinds) }),
  output: z.object({ story_id: z.string(), kind: z.enum(storyConvertKinds), id: z.string() }),
});
