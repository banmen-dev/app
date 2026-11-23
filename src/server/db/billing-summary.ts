// 請求管理者に見せる、担当組織1つの契約・上限・利用の状態と、使用量（人数と容量の合計の2値だけ）。
// 承諾済みの担当者でなければ、存在しない組織と同じ 404
import type { z } from 'zod';
import type { billingOrganizationSummary } from '../../shared/operations/billing.ts';

export async function readBillingOrganizationSummary(
  env: Env,
  slug: string,
  accountId: string,
  at: Date,
): Promise<z.input<typeof billingOrganizationSummary.output>> {
  void env;
  void slug;
  void accountId;
  void at;
  throw new Error('未実装');
}
