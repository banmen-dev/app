import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// タスクの親に選べるストーリー（削除していない、完了していないもの）を、バックログの木の順（エピックの順にその下のもの、
// 続けて親のないもの）で返す。エピックの下のものは親のエピック（epic）を添え、選択欄を親のエピックでまとめられるようにする。
// 削除したエピックの下のストーリーは、バックログの木と同じく出さない（backlog-tree の choices.stories と同じ候補）。
// ボードのカードの「親を変更」が、ダイアログを開くときに読む（木の全体を読む backlog-tree を呼ばないため）。閉じたワークスペースでも読める
export const storyChoices = defineOperation({
  name: 'story-choices',
  description:
    'タスクの親に選べる、完了していないストーリーを、バックログの木の順（エピックの順にその下のもの、続けて親のないもの）で、親のエピックつきで返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    stories: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        epic: z.object({ id: z.string(), title: z.string() }).nullable(),
      }),
    ),
  }),
});
