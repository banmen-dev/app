// 組織の契約（プランと支払いの周期）の表示の文。運用の画面と組織の変更の履歴が使う。
// translate は t（か、テストが言葉を決めた word）
import type { BillingInterval, OrganizationPlan } from '../shared/organization-plan.ts';
import { QUOTA_GIB } from '../shared/operations/operator/organization-quota-update.ts';
import { formatCount } from './format.ts';
import type { DictionaryKey, TemplateParams } from '../shared/vocabulary.ts';

type Translate = (key: DictionaryKey, params?: TemplateParams) => string;

const PLAN_KEYS = {
  personal: 'planPersonal',
  small: 'planSmall',
  team: 'planTeam',
  business: 'planBusiness',
  pro: 'planPro',
  custom: 'planCustom',
} as const satisfies Record<OrganizationPlan, DictionaryKey>;
const INTERVAL_KEYS = {
  monthly: 'billingMonthly',
  yearly: 'billingYearly',
} as const satisfies Record<BillingInterval, DictionaryKey>;

// 契約（プランと支払いの周期）の表示。「チーム・月払い」の形
export function planTermsText(
  terms: {
    plan: OrganizationPlan;
    billing_interval: BillingInterval;
    custom_member_limit?: number | null;
    custom_attachment_quota_bytes?: number | null;
  },
  translate: Translate,
): string {
  const text = translate('planTerms', {
    plan: translate(PLAN_KEYS[terms.plan]),
    interval: translate(INTERVAL_KEYS[terms.billing_interval]),
  });
  if (terms.plan === 'custom' && terms.custom_member_limit != null && terms.custom_attachment_quota_bytes != null) {
    return translate('planCustomLimits', {
      terms: text,
      members: formatCount(terms.custom_member_limit),
      quota: formatCount(terms.custom_attachment_quota_bytes / QUOTA_GIB),
    });
  }
  return text;
}

// 運用の画面の契約の印。契約があれば「チーム・月払い」の形、無ければ自分用は「パーソナル」、チーム用は「未契約」
export function planLabel(
  organization: {
    kind: 'team' | 'personal';
    contract: { plan: OrganizationPlan; billing_interval: BillingInterval } | null;
  },
  translate: Translate,
): string {
  if (organization.contract !== null)
    return planTermsText(
      { plan: organization.contract.plan, billing_interval: organization.contract.billing_interval },
      translate,
    );
  return translate(organization.kind === 'personal' ? 'planPersonal' : 'operatorPlanNone');
}

// 請求画面の担当組織の一覧の印。周期は出さずプラン名だけ（「チーム」）。契約が無ければ自分用は「パーソナル」、チーム用は「未契約」
export function planName(
  organization: { kind: 'team' | 'personal'; plan: OrganizationPlan | null },
  translate: Translate,
): string {
  if (organization.plan !== null) return translate(PLAN_KEYS[organization.plan]);
  return translate(organization.kind === 'personal' ? 'planPersonal' : 'operatorPlanNone');
}

// 請求画面の利用の状態の言葉（一覧の行と契約と使用量の紙で同じ）
export const billingStateKeys = {
  active: 'billingStateActive',
  suspended: 'billingStateSuspended',
  cancelled: 'billingStateCancelled',
} as const satisfies Record<'active' | 'suspended' | 'cancelled', DictionaryKey>;

// 前の版の個別契約は標準値を持たない。追加容量を変える前に、プランの変更で標準値を設定する。
export function needsCustomContractLimits(
  contract: {
    plan: OrganizationPlan;
    custom_member_limit?: number | null;
    custom_attachment_quota_bytes?: number | null;
  } | null,
): boolean {
  return (
    contract?.plan === 'custom' &&
    (contract.custom_member_limit == null || contract.custom_attachment_quota_bytes == null)
  );
}
