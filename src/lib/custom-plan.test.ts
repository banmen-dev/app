import { expect, test } from 'vitest';
import { QUOTA_GIB } from '../shared/operations/operator/organization-quota-update.ts';
import { initialCustomQuotaGb } from './custom-plan.ts';

test('ビジネスから個別へ切り替える初期標準容量に追加口数を含めない', () => {
  expect(
    initialCustomQuotaGb(
      { custom_attachment_quota_bytes: null, extra_10gb_units: 2, extra_50gb_units: 1 },
      170 * QUOTA_GIB,
    ),
  ).toBe(100);
});

test('既存の個別標準値はそのまま使い、未契約は現在上限を使う', () => {
  expect(
    initialCustomQuotaGb(
      { custom_attachment_quota_bytes: 200 * QUOTA_GIB, extra_10gb_units: 0, extra_50gb_units: 1 },
      250 * QUOTA_GIB,
    ),
  ).toBe(200);
  expect(initialCustomQuotaGb(null, 30 * QUOTA_GIB)).toBe(30);
});

test('口数を引いた値が1GB未満でも、初期入力は1GB以上の整数にする', () => {
  expect(
    initialCustomQuotaGb(
      { custom_attachment_quota_bytes: null, extra_10gb_units: 0, extra_50gb_units: 1 },
      50.4 * QUOTA_GIB,
    ),
  ).toBe(1);
  expect(
    initialCustomQuotaGb(
      { custom_attachment_quota_bytes: null, extra_10gb_units: 0, extra_50gb_units: 1 },
      52.6 * QUOTA_GIB,
    ),
  ).toBe(3);
});
