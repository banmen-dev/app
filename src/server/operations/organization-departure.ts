// 組織に入れなくなった人の扱い（Issue #1273）。組織に入れるのは、無効でない管理者と、いずれかのワークスペースに今所属している人
// （src/server/db/enter-organization.ts）。所属を終える書き込み（membership-leave）と管理者の解除（user-admin-update）は、
// この要求でその人が入れなくなったときに、同じ batch でプロフィール画像の行を消し、書いた後に R2 のファイルを消す
import {
  previousStatementChanged,
  type Expression,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { removeAvatarObjects } from '../avatars/remove.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

// その人が、管理者でなく、組織の中のどのワークスペースにも今所属していない（閉じたワークスペースの所属も数える）。
// enter-organization.ts の判定の裏返し（無効の人は別の経路で入れない）。EXISTS の中で使う
export function cannotEnterOrganization(from: From, organizationId: string, userId: string | Expression<string>) {
  return from
    .selectFrom('users as cu')
    .select('cu.id')
    .where('cu.id', '=', userId)
    .where('cu.organization_id', '=', organizationId)
    .where('cu.is_admin', '=', 0)
    .where((eb) =>
      eb.not(
        eb.exists(
          from
            .selectFrom('memberships as remaining')
            .innerJoin('workspaces as rw', 'rw.id', 'remaining.workspace_id')
            .select('remaining.id')
            .where('rw.organization_id', '=', organizationId)
            .where('rw.deleted_at', 'is', null)
            .where('remaining.user_id', '=', userId)
            .where('remaining.left_at', 'is', null),
        ),
      ),
    );
}

// この要求でその人が組織に入れなくなったときだけ、その人のプロフィール画像の行を消す文（変更の履歴は残さない）。
// writtenHere は「この要求で書いた」ことの見方で、関数なら、それが返す行（この要求で終えた所属など）があること、
// 'previous-statement' なら、直前の文が行を変えたこと（previousStatementChanged。直前に自分の文を置く）。
// 返す object_key は、batch の後に removeDepartedAvatarObjects へ渡す
export function removeDepartedAvatarStatement(
  db: OrganizationDb,
  userId: string,
  writtenHere: ((from: From) => Expression<unknown>) | 'previous-statement',
) {
  const organizationId = db.organizationId;
  return db.statement((q) => {
    const rows = q
      .deleteFrom('user_avatars')
      .where('user_id', '=', userId)
      .where('organization_id', '=', organizationId)
      .where((eb) => eb.exists(cannotEnterOrganization(q, organizationId, userId)));
    const written =
      writtenHere === 'previous-statement'
        ? rows.where(previousStatementChanged)
        : rows.where((eb) => eb.exists(writtenHere(q)));
    return written.returning('object_key');
  });
}

// 行が消えた後に R2 のファイルを消す（失敗は件数だけをログに出し、操作は成功にする）
export async function removeDepartedAvatarObjects(
  storage: Pick<R2Bucket, 'delete'>,
  result: { rows: readonly unknown[] } | undefined,
  operation: string,
): Promise<void> {
  await removeAvatarObjects(
    storage,
    (result?.rows ?? []).map((row) => (row as { object_key: string }).object_key),
    { operation },
  );
}
