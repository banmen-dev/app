import { EXTRA_10GB_BYTES, EXTRA_50GB_BYTES, type OrganizationPlan } from '../shared/organization-plan.ts';
import { QUOTA_GIB } from '../shared/operations/operator/organization-quota-update.ts';

// 個別の標準容量欄の初期値。口数は契約を切り替えても残すため、標準容量だけを取り出す。
export function initialCustomQuotaGb(
  contract: {
    plan: OrganizationPlan;
    custom_attachment_quota_bytes: number | null;
    extra_10gb_units: number;
    extra_50gb_units: number;
  } | null,
  totalQuotaBytes: number,
): number {
  const baseBytes =
    (contract?.plan === 'custom' ? contract.custom_attachment_quota_bytes : null) ??
    totalQuotaBytes -
      (contract?.extra_10gb_units ?? 0) * EXTRA_10GB_BYTES -
      (contract?.extra_50gb_units ?? 0) * EXTRA_50GB_BYTES;
  return Math.max(1, Math.round(baseBytes / QUOTA_GIB));
}
