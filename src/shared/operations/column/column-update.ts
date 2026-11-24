import { z } from 'zod';
import { columnNameSchema, columnWipLimitSchema } from '../../column.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { columnSchema } from './column.ts';

// 列の名前と上限を直す。name と wip_limit はどちらも省けるが、少なくとも1つを送る（どちらも無ければ 400 の invalid_input）。
// wip_limit は 1〜99 の整数で、null は上限を外す。上限は超えても移動と追加を止めない目安で、変更の履歴には残さない。
// 名前は今の名前と違うときだけ、読んだ名前のままなら、という条件つきで書き、変更の履歴
// （entity_type = 'workspace'、update、{"column": [{id, name: 前}, {id, name: 後}]}）を残す。
// 同じ名前の列があれば 409 の conflict（duplicate_name）。完了の列は名前も上限も持たず直せないので、無い列（別の組織、別のワークスペース、
// 削除済みを含む）と同じ 404
export const columnUpdate = defineOperation({
  name: 'column-update',
  description: '列の名前と上限を直す。完了の列は直せない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z
    .object({
      workspace_id: idSchema,
      column_id: idSchema,
      name: columnNameSchema.optional(),
      wip_limit: columnWipLimitSchema.nullable().optional(),
    })
    .refine((value) => value.name !== undefined || value.wip_limit !== undefined, {
      message: 'name か wip_limit を送ってください',
    }),
  output: z.object({ column: columnSchema }),
});
