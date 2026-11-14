import type { ExpressionBuilder, OrganizationTables } from '../db/index.ts';

// tasks を持つ文から呼ぶ。付与と見込みで同じ条件を使い、書き込み時点の値から受取人を選ぶ。
// 候補の値が1件も無ければ NULL になるので、欄が0件の場合にも経験値は付かない。
export function detailedRecipient<DB, TB extends keyof DB>(builder: ExpressionBuilder<DB, TB>) {
  const eb = builder as unknown as ExpressionBuilder<OrganizationTables, 'tasks'>;
  return eb
    .selectFrom('task_field_values as detail_value')
    .innerJoin('detail_fields as detail_field', 'detail_field.id', 'detail_value.field_id')
    .select('detail_value.updated_by')
    .whereRef('detail_value.task_id', '=', 'tasks.id')
    .whereRef('detail_field.workspace_id', '=', 'tasks.workspace_id')
    .where('detail_field.deleted_at', 'is', null)
    .where((inner) =>
      inner.not(
        inner.exists(
          inner
            .selectFrom('detail_fields as required_field')
            .select('required_field.id')
            .whereRef('required_field.workspace_id', '=', 'tasks.workspace_id')
            .where('required_field.deleted_at', 'is', null)
            .where((missing) =>
              missing.not(
                missing.exists(
                  missing
                    .selectFrom('task_field_values as required_value')
                    .select('required_value.field_id')
                    .whereRef('required_value.task_id', '=', 'tasks.id')
                    .whereRef('required_value.field_id', '=', 'required_field.id'),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy('detail_value.updated_at', 'desc')
    .orderBy('detail_value.field_id', 'desc')
    .limit(1);
}
