// 請求専用の認可と書き込み。共通DBの表だけを使い、業務用の組織入口を作らない。
import { sql } from 'kysely';
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
const writableOrganization = (organizationId: string, at: Date) => sql<boolean>`EXISTS (
  SELECT 1 FROM organizations WHERE id = ${organizationId} AND (suspended_at IS NULL OR ${purgeNotDue(at.toISOString().slice(0, 10))})
)`;

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

export async function listBillingOrganizations(db: CommonDb, accountId: string) {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('billing_administrators as b')
        .innerJoin('organizations as o', 'o.id', 'b.organization_id')
        .select(['b.id', 'b.status', 'o.slug', 'o.name'])
        .where('b.account_id', '=', accountId)
        .where('b.status', 'in', ['active', 'pending'])
        .orderBy('o.name')
        .orderBy('o.id'),
    ),
  );
  return {
    organizations: rows.filter((row) => row.status === 'active').map(({ slug, name }) => ({ slug, name })),
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
        .selectFrom('billing_admin_events')
        .select(['id', 'actor_account_id', 'target_account_id', 'action', 'created_at'])
        .where('organization_id', '=', organization.id)
        .where(activeActor(organization.id, accountId))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
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
        .select(['id', 'status'])
        .where('organization_id', '=', organization.id)
        .where('account_id', '=', input.account_id),
    ),
  );
  if (current?.status === 'active' || current?.status === 'pending') return { id: current.id };
  const id = uuidv7(at.getTime());
  const authorized = operator ? bootstrapAllowed(organization.id) : activeActor(organization.id, actorId);
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .insertInto('billing_administrators')
        .columns(['id', 'organization_id', 'account_id', 'status', 'invited_by', 'created_at', 'updated_at'])
        .expression(
          q
            .selectFrom('accounts')
            .select((eb) => [
              eb.val(id).as('id'),
              eb.val(organization.id).as('organization_id'),
              'accounts.id as account_id',
              eb.val('pending').as('status'),
              eb.val(actorId).as('invited_by'),
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
              created_at: at.toISOString(),
              updated_at: at.toISOString(),
            })
            .where('billing_administrators.status', 'in', ['declined', 'revoked'])
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
          'organizations.suspended_at',
          'organizations.purge_on',
          purgeDueInDatabase().as('due_in_database'),
        ])
        .where('b.id', '=', invitationId)
        .where('b.account_id', '=', accountId),
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
        .where(writableOrganization(row.organization_id, at)),
    ),
    eventStatement(db, row.organization_id, accountId, accountId, accept ? 'accepted' : 'declined', at),
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
  ]);
  if (result.changes === 0) throw new ApiError(409, 'conflict');
}
