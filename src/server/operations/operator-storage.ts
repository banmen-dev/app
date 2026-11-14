// 運用者の追加容量の変更（docs/data-model.md の「書き込みの単位」の追加容量の変更）。
// 自分用は personal の契約を作れる。人数、お試し、停止は変えず、チーム用の支払いの周期は今の契約にそろえる。
// 共通の DB の organization_contracts と organizations を1回の batch() で書き（どちらも共通の表）、続けて組織の DB の change_logs に
// 運用者の操作として残す。2つの DB への書き込みは別の batch() で書く。履歴を書けなくても成功として返す。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータを入れない
import { now } from '../../shared/clock.ts';
import { isPurgeDue, organizationStorageUpdate, utcDateOf } from '../../shared/operations/operator/index.ts';
import { contractLimits } from '../../shared/organization-plan.ts';
import { previousStatementChanged, purgeNotDue, type CommonTables, type ExpressionBuilder } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { logOperatorChange } from './operator-change-log.ts';
import { readOrganizationWithContract } from './operator-plan.ts';

export const organizationStorageUpdateOperation = implement(
  organizationStorageUpdate,
  async ({ db, operator, input }) => {
    const at = now();
    const current = await readOrganizationWithContract(db, input.slug);
    const due =
      current.suspended_at !== null && (isPurgeDue(current.purge_on, at) || Number(current.due_in_database) === 1);
    if (due) throw new ApiError(409, 'purge_due');
    const { contract } = current;
    if (current.kind === 'team' && contract === null) throw new ApiError(409, 'conflict', { reason: 'plan_required' });
    // 個別の標準値が無い古い行は、先にプランの変更で値を決め直す。
    if (
      contract?.plan === 'custom' &&
      (contract.custom_member_limit === null || contract.custom_attachment_quota_bytes === null)
    ) {
      throw new ApiError(409, 'conflict');
    }
    // チーム用は基本プランとまとめて請求する。周期はプランの変更でだけ変え、追加容量の操作では維持する。
    if (current.kind === 'team' && contract!.billing_interval !== input.billing_interval) {
      throw new ApiError(409, 'conflict');
    }
    if (
      contract !== null &&
      contract.billing_interval === input.billing_interval &&
      contract.extra_10gb_units === input.extra_10gb_units &&
      contract.extra_50gb_units === input.extra_50gb_units
    ) {
      return {
        slug: input.slug,
        contract,
        member_limit: current.member_limit,
        attachment_quota_bytes: current.attachment_quota_bytes,
        trial_ends_on: current.trial_ends_on,
      };
    }
    const { expected } = input;
    const matchesExpected =
      expected === null
        ? contract === null
        : contract !== null &&
          contract.plan === expected.plan &&
          contract.billing_interval === expected.billing_interval &&
          contract.extra_10gb_units === expected.extra_10gb_units &&
          contract.extra_50gb_units === expected.extra_50gb_units &&
          contract.custom_member_limit === expected.custom_member_limit &&
          contract.custom_attachment_quota_bytes === expected.custom_attachment_quota_bytes;
    if (!matchesExpected) throw new ApiError(409, 'conflict');

    const next = {
      plan: current.kind === 'personal' ? ('personal' as const) : contract!.plan,
      billing_interval: input.billing_interval,
      custom_member_limit: contract?.custom_member_limit ?? null,
      custom_attachment_quota_bytes: contract?.custom_attachment_quota_bytes ?? null,
      extra_10gb_units: input.extra_10gb_units,
      extra_50gb_units: input.extra_50gb_units,
    };
    const limits = contractLimits(next);
    const raised = limits.attachment_quota_bytes > current.attachment_quota_bytes;
    const stamp = at.toISOString();
    const today = utcDateOf(at);
    // 契約を書く文の条件。組織が、読んだときの上限のままで、消す予定日を過ぎた解約の停止でないこと。
    // 読んだ後に別の運用者が上限を値で変えていたら書かない（履歴の前の値と、通知の日時を戻すかの判断を、読んだ値で決めているため）。
    // 読んだ後に日付が変わっても、消している途中の組織には足さない
    const organizationAsRead = (eb: ExpressionBuilder<CommonTables, 'organizations'>) =>
      eb.and([
        eb('organizations.id', '=', current.id),
        eb('organizations.member_limit', '=', current.member_limit),
        eb('organizations.attachment_quota_bytes', '=', current.attachment_quota_bytes),
        eb.or([eb('organizations.suspended_at', 'is', null), purgeNotDue(today)]),
      ]);

    const [written] = await db.batch([
      contract === null
        ? db.statement((q) =>
            q
              .insertInto('organization_contracts')
              .columns([
                'organization_id',
                'plan',
                'billing_interval',
                'extra_10gb_units',
                'extra_50gb_units',
                'created_at',
                'updated_at',
              ])
              .expression((eb) =>
                eb
                  .selectFrom('organizations')
                  .select([
                    'organizations.id',
                    eb.val(next.plan).as('plan'),
                    eb.val(next.billing_interval).as('billing_interval'),
                    eb.val(next.extra_10gb_units).as('extra_10gb_units'),
                    eb.val(next.extra_50gb_units).as('extra_50gb_units'),
                    eb.val(stamp).as('created_at'),
                    eb.val(stamp).as('updated_at'),
                  ])
                  .where(organizationAsRead),
              )
              .onConflict((oc) => oc.column('organization_id').doNothing()),
          )
        : db.statement((q) =>
            q
              .updateTable('organization_contracts')
              .set({ ...next, updated_at: stamp })
              .where('organization_id', '=', current.id)
              .where('plan', '=', contract.plan)
              .where('billing_interval', '=', contract.billing_interval)
              .where('extra_10gb_units', '=', contract.extra_10gb_units)
              .where('extra_50gb_units', '=', contract.extra_50gb_units)
              .where('custom_member_limit', 'is', contract.custom_member_limit)
              .where('custom_attachment_quota_bytes', 'is', contract.custom_attachment_quota_bytes)
              .where((eb) =>
                eb.exists(eb.selectFrom('organizations').select('organizations.id').where(organizationAsRead)),
              ),
          ),
      db.statement((q) =>
        q
          .updateTable('organizations')
          .where(previousStatementChanged)
          .set({
            attachment_quota_bytes: limits.attachment_quota_bytes,
            ...(raised ? { attachment_quota_warned_at: null, attachment_quota_warning_pending_at: null } : {}),
            updated_at: stamp,
          })
          .where('id', '=', current.id)
          .where('member_limit', '=', current.member_limit)
          .where('attachment_quota_bytes', '=', current.attachment_quota_bytes)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('organization_contracts')
                .select('organization_contracts.organization_id')
                .where('organization_contracts.organization_id', '=', current.id)
                .where('organization_contracts.plan', '=', next.plan)
                .where('organization_contracts.billing_interval', '=', next.billing_interval)
                .where('organization_contracts.extra_10gb_units', '=', next.extra_10gb_units)
                .where('organization_contracts.extra_50gb_units', '=', next.extra_50gb_units)
                .where('organization_contracts.updated_at', '=', stamp),
            ),
          ),
      ),
    ]);
    if (written.changes === 0) throw new ApiError(409, 'conflict');

    // 契約のプランと支払いの周期は、片方だけが変わっても組で残す（履歴の文に前後の契約を出すため）。ほかは変わった列だけ
    const changes: Record<string, readonly [unknown, unknown]> = {
      plan: [contract?.plan ?? null, next.plan],
      billing_interval: [contract?.billing_interval ?? null, next.billing_interval],
    };
    changes.extra_10gb_units = [contract?.extra_10gb_units ?? 0, next.extra_10gb_units];
    changes.extra_50gb_units = [contract?.extra_50gb_units ?? 0, next.extra_50gb_units];
    if (current.attachment_quota_bytes !== limits.attachment_quota_bytes) {
      changes.attachment_quota_bytes = [current.attachment_quota_bytes, limits.attachment_quota_bytes];
    }
    if (raised && current.attachment_quota_warned_at !== null) {
      changes.attachment_quota_warned_at = [current.attachment_quota_warned_at, null];
    }
    await logOperatorChange(operator, {
      operation: organizationStorageUpdate.name,
      organizationId: current.id,
      action: 'update',
      changes,
      at,
    });
    return {
      slug: input.slug,
      contract: next,
      member_limit: current.member_limit,
      attachment_quota_bytes: limits.attachment_quota_bytes,
      trial_ends_on: current.trial_ends_on,
    };
  },
);
