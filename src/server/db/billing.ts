// 請求専用の認可と書き込み。共通DBの表だけを使い、業務用の組織入口を作らない。
import { sql } from 'kysely';
import type { OrganizationKind } from '../../shared/organization-kind.ts';
import type { OrganizationPlan } from '../../shared/organization-plan.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import type { CommonDb } from './entries.ts';
import { previousStatementChanged } from './previous-statement.ts';
import { purgeDueInDatabase, purgeNotDue } from './purge-due.ts';

const activeActor = (organizationId: string, accountId: string) => sql<boolean>`EXISTS (
  SELECT 1 FROM billing_administrators AS actor
  WHERE actor.organization_id = ${organizationId} AND actor.account_id = ${accountId} AND actor.status = 'active'
)`;
const bootstrapAllowed = (organizationId: string) => sql<boolean>`NOT EXISTS (
  SELECT 1 FROM billing_administrators AS actor WHERE actor.organization_id = ${organizationId} AND actor.status = 'active'
)`;
const writableOrganization = (organizationId: string | ReturnType<typeof sql.ref>, at: Date) => sql<boolean>`EXISTS (
  SELECT 1 FROM organizations WHERE id = ${organizationId} AND (suspended_at IS NULL OR ${purgeNotDue(at.toISOString().slice(0, 10))})
)`;

// 指名元が現在も権限を持つことを、読むときと書くときの両方で検査する。
// 運用者の初回指名は、誰かが承諾した時点で残りも失効する。
function validInvitation(table: 'b' | 'billing_administrators') {
  const organization = sql.ref(`${table}.organization_id`);
  const invitedBy = sql.ref(`${table}.invited_by`);
  const bootstrap = sql.ref(`${table}.is_bootstrap`);
  return sql<boolean>`(
    (${bootstrap} = 0 AND EXISTS (
      SELECT 1 FROM billing_administrators AS inviter
      WHERE inviter.organization_id = ${organization} AND inviter.account_id = ${invitedBy} AND inviter.status = 'active'
    )) OR (${bootstrap} = 1 AND NOT EXISTS (
      SELECT 1 FROM billing_administrators AS incumbent
      WHERE incumbent.organization_id = ${organization} AND incumbent.status = 'active'
    ))
  )`;
}

async function organizationFor(db: CommonDb, slug: string, accountId: string, operator = false) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('organizations')
        .select(['id', 'suspended_at', 'purge_on', purgeDueInDatabase().as('due_in_database')])
        .where('slug', '=', slug)
        .$if(!operator, (query) => query.where(activeActorBySlug(slug, accountId))),
    ),
  );
  if (!row) throw new ApiError(404, 'not_found');
  return row;
}
const activeActorBySlug = (slug: string, accountId: string) => sql<boolean>`EXISTS (
  SELECT 1 FROM billing_administrators AS actor JOIN organizations AS o ON o.id = actor.organization_id
  WHERE o.slug = ${slug} AND actor.account_id = ${accountId} AND actor.status = 'active'
)`;
function checkWritable(
  row: { suspended_at: string | null; purge_on: string | null; due_in_database: number },
  at: Date,
) {
  if (
    row.suspended_at !== null &&
    (Number(row.due_in_database) === 1 || (row.purge_on !== null && row.purge_on < at.toISOString().slice(0, 10)))
  ) {
    throw new ApiError(409, 'purge_due');
  }
}
function eventStatement(
  db: CommonDb,
  organizationId: string,
  actorId: string,
  targetId: string,
  action: 'invited' | 'accepted' | 'declined' | 'removed',
  at: Date,
) {
  return db.statement((q) =>
    q
      .insertInto('billing_admin_events')
      .columns(['id', 'organization_id', 'actor_account_id', 'target_account_id', 'action', 'created_at'])
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(uuidv7(at.getTime())).as('id'),
            eb.val(organizationId).as('organization_id'),
            eb.val(actorId).as('actor_account_id'),
            eb.val(targetId).as('target_account_id'),
            eb.val(action).as('action'),
            eb.val(at.toISOString()).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}

export async function listBillingOrganizations(db: CommonDb, accountId: string, at: Date) {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('billing_administrators as b')
        .innerJoin('organizations as o', 'o.id', 'b.organization_id')
        // 契約の表も共通の表なので、1つの文で読む（共通の表と組織の中の表は結合しない）
        .leftJoin('organization_contracts as c', 'c.organization_id', 'o.id')
        .select(['b.id', 'b.status', 'o.slug', 'o.name', 'o.kind', 'o.suspended_at', 'o.purge_on', 'c.plan'])
        .where('b.account_id', '=', accountId)
        .where('b.status', 'in', ['active', 'pending'])
        .where((eb) =>
          eb.or([
            eb('b.status', '=', 'active'),
            eb.and([validInvitation('b'), writableOrganization(sql.ref('b.organization_id'), at)]),
          ]),
        )
        .orderBy('o.name')
        .orderBy('o.id'),
    ),
  );
  return {
    // 停止していなければ active、停止して purge_on が空なら suspended、あれば cancelled（運用者の一覧と同じ境目）。
    // 停止中と消す予定日を過ぎた組織も、消すまでは一覧に出す
    organizations: rows
      .filter((row) => row.status === 'active')
      .map(({ slug, name, kind, plan, suspended_at, purge_on }) => ({
        slug,
        name,
        // 列の CHECK が守る値
        kind: kind as OrganizationKind,
        plan: plan as OrganizationPlan | null,
        state: (suspended_at === null ? 'active' : purge_on === null ? 'suspended' : 'cancelled') as
          'active' | 'suspended' | 'cancelled',
      })),
    invitations: rows.filter((row) => row.status === 'pending').map(({ id, slug, name }) => ({ id, slug, name })),
  };
}
export async function listBillingAdministrators(db: CommonDb, slug: string, accountId: string) {
  const organization = await organizationFor(db, slug, accountId);
  // 各読み取りにも現在の権限を条件として持つ。認可の読み取り後に解除されても担当者情報を返さない。
  const [administrators, events] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('billing_administrators as b')
        .leftJoin('account_profiles as p', 'p.account_id', 'b.account_id')
        .select([
          'b.id',
          'b.account_id',
          'b.status',
          sql<string>`coalesce(nullif(p.name, ''), b.account_id)`.as('name'),
        ])
        .where('b.organization_id', '=', organization.id)
        .where('b.status', 'in', ['active', 'pending'])
        .where(activeActor(organization.id, accountId))
        .orderBy('b.created_at')
        .orderBy('b.id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('billing_admin_events as e')
        .leftJoin('account_profiles as actor_profile', 'actor_profile.account_id', 'e.actor_account_id')
        .leftJoin('account_profiles as target_profile', 'target_profile.account_id', 'e.target_account_id')
        .select([
          'e.id',
          'e.actor_account_id',
          'e.target_account_id',
          'e.action',
          'e.created_at',
          sql<string>`coalesce(nullif(actor_profile.name, ''), e.actor_account_id)`.as('actor_name'),
          sql<string>`coalesce(nullif(target_profile.name, ''), e.target_account_id)`.as('target_name'),
        ])
        .where('e.organization_id', '=', organization.id)
        .where(activeActor(organization.id, accountId))
        .orderBy('e.created_at', 'desc')
        .orderBy('e.id', 'desc')
        .limit(50),
    ),
  ]);
  if (!administrators.rows.some((row) => row.account_id === accountId && row.status === 'active'))
    throw new ApiError(404, 'not_found');
  return {
    administrators: administrators.rows.map((row) => ({ ...row, status: row.status as 'pending' | 'active' })),
    events: events.rows.map((row) => ({
      ...row,
      action: row.action as 'invited' | 'accepted' | 'declined' | 'removed',
    })),
  };
}

export async function inviteBillingAdministrator(
  db: CommonDb,
  input: { slug: string; account_id: string },
  actorId: string,
  at: Date,
  operator = false,
) {
  const organization = await organizationFor(db, input.slug, actorId, operator);
  checkWritable(organization, at);
  if (operator) {
    const active = await db.first(
      db.statement((q) =>
        q
          .selectFrom('billing_administrators')
          .select('id')
          .where('organization_id', '=', organization.id)
          .where('status', '=', 'active')
          .limit(1),
      ),
    );
    if (active) throw new ApiError(409, 'conflict');
  }
  const target = await db.first(
    db.statement((q) => q.selectFrom('accounts').select('id').where('id', '=', input.account_id)),
  );
  if (!target) throw new ApiError(404, 'not_found');
  const current = await db.first(
    db.statement((q) =>
      q
        .selectFrom('billing_administrators')
        .select(['id', 'status', validInvitation('billing_administrators').as('valid_invitation')])
        .where('organization_id', '=', organization.id)
        .where('account_id', '=', input.account_id),
    ),
  );
  if (current?.status === 'active' || (current?.status === 'pending' && Number(current.valid_invitation) === 1))
    return { id: current.id };
  const id = uuidv7(at.getTime());
  const authorized = operator ? bootstrapAllowed(organization.id) : activeActor(organization.id, actorId);
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .insertInto('billing_administrators')
        .columns([
          'id',
          'organization_id',
          'account_id',
          'status',
          'invited_by',
          'is_bootstrap',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectFrom('accounts')
            .select((eb) => [
              eb.val(id).as('id'),
              eb.val(organization.id).as('organization_id'),
              'accounts.id as account_id',
              eb.val('pending').as('status'),
              eb.val(actorId).as('invited_by'),
              eb.val(operator ? 1 : 0).as('is_bootstrap'),
              eb.val(at.toISOString()).as('created_at'),
              eb.val(at.toISOString()).as('updated_at'),
            ])
            .where('accounts.id', '=', input.account_id)
            .where(authorized)
            .where(writableOrganization(organization.id, at)),
        )
        .onConflict((oc) =>
          oc
            .columns(['organization_id', 'account_id'])
            .doUpdateSet({
              id,
              status: 'pending',
              invited_by: actorId,
              is_bootstrap: operator ? 1 : 0,
              created_at: at.toISOString(),
              updated_at: at.toISOString(),
            })
            .where((eb) =>
              eb.or([
                eb('billing_administrators.status', 'in', ['declined', 'revoked']),
                eb.and([
                  eb('billing_administrators.status', '=', 'pending'),
                  eb.not(validInvitation('billing_administrators')),
                ]),
              ]),
            )
            .where(authorized)
            .where(writableOrganization(organization.id, at)),
        ),
    ),
    eventStatement(db, organization.id, actorId, input.account_id, 'invited', at),
  ]);
  if (result.changes === 0) throw new ApiError(409, 'conflict');
  return { id };
}

export async function respondBillingInvitation(
  db: CommonDb,
  invitationId: string,
  accept: boolean,
  accountId: string,
  at: Date,
) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('billing_administrators as b')
        .innerJoin('organizations', 'organizations.id', 'b.organization_id')
        .select([
          'b.organization_id',
          'b.status',
          'b.is_bootstrap',
          'organizations.suspended_at',
          'organizations.purge_on',
          purgeDueInDatabase().as('due_in_database'),
        ])
        .where('b.id', '=', invitationId)
        .where('b.account_id', '=', accountId)
        .where((eb) => eb.or([eb('b.status', '!=', 'pending'), validInvitation('b')]))
        .where('b.status', '!=', 'revoked'),
    ),
  );
  if (!row) throw new ApiError(404, 'not_found');
  checkWritable(row, at);
  if (row.status !== 'pending') throw new ApiError(409, 'conflict');
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('billing_administrators')
        .set({ status: accept ? 'active' : 'declined', updated_at: at.toISOString() })
        .where('id', '=', invitationId)
        .where('account_id', '=', accountId)
        .where('organization_id', '=', row.organization_id)
        .where('status', '=', 'pending')
        .where(validInvitation('billing_administrators'))
        .where(writableOrganization(row.organization_id, at)),
    ),
    eventStatement(db, row.organization_id, accountId, accountId, accept ? 'accepted' : 'declined', at),
    // 初回承諾の自動的な結果として、残りの初回指名を恒久的に失効させる。
    // 直前の承諾イベントが書けた場合だけ変更するので、競合した要求は何も失効させない。
    // 未承諾の指名にはまだ権限が無いため、別の権限解除イベントは作らない。
    ...(accept && row.is_bootstrap === 1
      ? [
          db.statement((q) =>
            q
              .updateTable('billing_administrators')
              .set({ status: 'revoked', updated_at: at.toISOString() })
              .where('organization_id', '=', row.organization_id)
              .where('id', '!=', invitationId)
              .where('status', '=', 'pending')
              .where('is_bootstrap', '=', 1)
              .where(previousStatementChanged),
          ),
        ]
      : []),
  ]);
  if (result.changes === 0) throw new ApiError(409, 'conflict');
}
export async function removeBillingAdministrator(
  db: CommonDb,
  slug: string,
  administratorId: string,
  accountId: string,
  at: Date,
) {
  const organization = await organizationFor(db, slug, accountId);
  checkWritable(organization, at);
  const target = await db.first(
    db.statement((q) =>
      q
        .selectFrom('billing_administrators')
        .select(['account_id', 'status'])
        .where('id', '=', administratorId)
        .where('organization_id', '=', organization.id)
        .where('status', 'in', ['pending', 'active']),
    ),
  );
  if (!target) throw new ApiError(404, 'not_found');
  // 同じ UPDATE 内で数えるので、2人の同時の自己解除でも契約中の担当者は残る。
  const retainsAdministrator = sql<boolean>`(billing_administrators.status <> 'active'
    OR NOT EXISTS (SELECT 1 FROM organization_contracts WHERE organization_id = ${organization.id})
    OR (SELECT count(*) FROM billing_administrators AS remaining WHERE remaining.organization_id = ${organization.id} AND remaining.status = 'active') > 1)`;
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('billing_administrators')
        .set({ status: 'revoked', updated_at: at.toISOString() })
        .where('id', '=', administratorId)
        .where('organization_id', '=', organization.id)
        .where('status', 'in', ['pending', 'active'])
        .where(activeActor(organization.id, accountId))
        .where(writableOrganization(organization.id, at))
        .where(retainsAdministrator),
    ),
    eventStatement(db, organization.id, accountId, target.account_id, 'removed', at),
    // 解除された担当者が後で復帰しても、解除前の通常指名を復活させない。
    // 解除イベントが保存できた場合だけ、その自動結果として未承諾の指名を恒久失効する。
    db.statement((q) =>
      q
        .updateTable('billing_administrators')
        .set({ status: 'revoked', updated_at: at.toISOString() })
        .where('organization_id', '=', organization.id)
        .where('invited_by', '=', target.account_id)
        .where('status', '=', 'pending')
        .where('is_bootstrap', '=', 0)
        .where(previousStatementChanged),
    ),
  ]);
  if (result.changes === 0) throw new ApiError(409, 'conflict');
}
