import { z } from 'zod';
import { billingIntervals } from '../../organization-plan.ts';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';
import { organizationContract, organizationPlanUpdate } from './organization-plan-update.ts';

// 契約と容量は共通 DB の1回の batch() で更新する。人数、お試し、停止は変えない。
// 自分用は personal 固定で契約を作り、チーム用の未契約は plan_required で断る。チーム用の周期は今の契約と同じ値だけを受け付ける。
export const organizationStorageUpdate = defineOperation({
  name: 'organization-storage-update',
  description:
    '運用者が組織の追加容量の口数を変える。チーム用は契約の支払いの周期を変えられない。自分用は周期を選んでパーソナルの契約を作る。未契約のチーム用は先にプランを決める。expected と契約が違えば409。消す予定日を過ぎた組織は purge_due',
  mode: 'write',
  permission: 'operator',
  input: z.object({
    slug: z.string().max(SLUG_MAX_LENGTH * 2),
    billing_interval: z.enum(billingIntervals),
    extra_10gb_units: z.number().int().min(0).max(100),
    extra_50gb_units: z.number().int().min(0).max(100),
    expected: organizationContract.nullable(),
  }),
  output: organizationPlanUpdate.output,
});
