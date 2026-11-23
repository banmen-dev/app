import { describe, expect, test } from 'vitest';
import { word, type DictionaryKey, type TemplateParams } from '../shared/vocabulary.ts';
import { needsCustomContractLimits, planLabel, planName, planTermsText } from './plan-terms.ts';

const t = (key: DictionaryKey, params?: TemplateParams) => word(key, params);

describe('planTermsText', () => {
  test('プランと支払いの周期を「・」でつなぐ', () => {
    expect(planTermsText({ plan: 'team', billing_interval: 'monthly' }, t)).toBe('チーム・月払い');
    expect(planTermsText({ plan: 'business', billing_interval: 'yearly' }, t)).toBe('ビジネス・年払い');
    expect(planTermsText({ plan: 'personal', billing_interval: 'monthly' }, t)).toBe('パーソナル・月払い');
    expect(planTermsText({ plan: 'custom', billing_interval: 'yearly' }, t)).toBe('個別・年払い');
  });
});

test('個別の契約の履歴には標準の値を添え、通常プランには添えない', () => {
  expect(
    planTermsText(
      {
        plan: 'custom',
        billing_interval: 'yearly',
        custom_member_limit: 80,
        custom_attachment_quota_bytes: 200 * 1024 ** 3,
      },
      t,
    ),
  ).toBe('個別・年払い（80 人・標準 200 GB）');
  expect(
    planTermsText(
      { plan: 'business', billing_interval: 'yearly', custom_member_limit: null, custom_attachment_quota_bytes: null },
      t,
    ),
  ).toBe('ビジネス・年払い');
});

describe('planLabel', () => {
  test('契約があれば契約、無ければ自分用はパーソナル、チーム用は未契約', () => {
    const contract = { plan: 'business', billing_interval: 'monthly' } as const;
    expect(planLabel({ kind: 'team', contract }, t)).toBe('ビジネス・月払い');
    expect(planLabel({ kind: 'team', contract: null }, t)).toBe('未契約');
    expect(planLabel({ kind: 'personal', contract: null }, t)).toBe('パーソナル');
  });
});

test('個別契約の標準値が欠けたときだけ、追加容量の前にプランの設定を求める', () => {
  expect(
    needsCustomContractLimits({ plan: 'custom', custom_member_limit: null, custom_attachment_quota_bytes: null }),
  ).toBe(true);
  expect(
    needsCustomContractLimits({ plan: 'custom', custom_member_limit: 80, custom_attachment_quota_bytes: null }),
  ).toBe(true);
  expect(
    needsCustomContractLimits({
      plan: 'custom',
      custom_member_limit: null,
      custom_attachment_quota_bytes: 200 * 1024 ** 3,
    }),
  ).toBe(true);
  expect(needsCustomContractLimits({ plan: 'custom' })).toBe(true);
  expect(
    needsCustomContractLimits({
      plan: 'custom',
      custom_member_limit: 80,
      custom_attachment_quota_bytes: 200 * 1024 ** 3,
    }),
  ).toBe(false);
  expect(
    needsCustomContractLimits({ plan: 'business', custom_member_limit: null, custom_attachment_quota_bytes: null }),
  ).toBe(false);
  expect(needsCustomContractLimits(null)).toBe(false);
});

test('個別契約の履歴の人数とGBをほかの上限表示と同じ桁区切りで出す', () => {
  expect(
    planTermsText(
      {
        plan: 'custom',
        billing_interval: 'yearly',
        custom_member_limit: 1000,
        custom_attachment_quota_bytes: 2048 * 1024 ** 3,
      },
      t,
    ),
  ).toBe('個別・年払い（1,000 人・標準 2,048 GB）');
});

test.each([
  ['small', 'スモール'],
  ['pro', 'プロ'],
] as const)('%s の契約を名前で表示する', (plan, name) => {
  expect(planLabel({ kind: 'team', contract: { plan, billing_interval: 'monthly' } }, t)).toBe(`${name}・月払い`);
  expect(planTermsText({ plan, billing_interval: 'yearly' }, t)).toBe(`${name}・年払い`);
});

describe('planName', () => {
  test('契約があればプラン名だけを出し、支払いの周期は出さない', () => {
    expect(planName({ kind: 'team', plan: 'team' }, t)).toBe('チーム');
    expect(planName({ kind: 'team', plan: 'custom' }, t)).toBe('個別');
    expect(planName({ kind: 'personal', plan: 'personal' }, t)).toBe('パーソナル');
  });
  test('契約が無ければチーム用は「未契約」、自分用は「パーソナル」', () => {
    expect(planName({ kind: 'team', plan: null }, t)).toBe('未契約');
    expect(planName({ kind: 'personal', plan: null }, t)).toBe('パーソナル');
  });
});
