import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// エピックのクリアと取り消しを 409 の conflict で断った理由（details.reason）。
// open_stories は配下に削除していない未完了のストーリーが残っている、empty は配下に削除していないストーリーが1件も無い、
// completed はすでにクリアしている（2つの画面から同時にクリアした後の方を含む）、not_completed はクリアしていないエピックを取り消そうとした、
// changed は読んでから書くまでに別の要求が配下を変えた（やり直しても書けなかった）。
export const epicClearConflictReasons = ['open_stories', 'empty', 'completed', 'not_completed', 'changed'] as const;
export type EpicClearConflictReason = (typeof epicClearConflictReasons)[number];

export function epicClearConflictReasonOf(details: unknown): EpicClearConflictReason | undefined {
  return conflictReasonOf(details, epicClearConflictReasons);
}

// エピックをクリアする。依頼主とリーダー（管理者を含む）だけ（足りなければ 403 の forbidden）。
// 配下の削除していないストーリーがすべて完了していることが条件で、未完了が残っていれば 409 の conflict（open_stories）、
// 1件も無ければ 409 の conflict（empty）。
// 履歴（entity_type = 'epic'、complete）も同じ batch() で書く。
// 無いエピック（別の組織を含む）は 404、閉じたワークスペースは 409 の workspace_closed
export const epicComplete = defineOperation({
  name: 'epic-complete',
  description: '配下のストーリーがすべて完了したエピックをクリアする',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({
    epic_id: z.string(),
    completed_at: z.string(),
  }),
});

// エピックのクリアを取り消す。クリアした日時とクリアにした人を空に戻す。依頼主とリーダー（管理者を含む）だけ。
// クリアしていなければ 409 の conflict（not_completed）。
// 履歴（entity_type = 'epic'、reopen）も同じ batch() で書く。無いエピック（別の組織を含む）は 404
export const epicReopen = defineOperation({
  name: 'epic-reopen',
  description: 'エピックのクリアを取り消す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({ epic_id: z.string() }),
});
