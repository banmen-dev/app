import { z } from 'zod';
import { billingIntervals, organizationPlans, teamPlans } from '../../organization-plan.ts';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';
import { MEMBER_LIMIT_MAX, ATTACHMENT_QUOTA_MAX_BYTES, QUOTA_GIB } from './organization-quota-update.ts';

// 組織の契約の形。追加容量はプランの標準の容量に足す
export const organizationContract = z.object({
  plan: z.enum(organizationPlans),
  billing_interval: z.enum(billingIntervals),
  extra_10gb_units: z.number().int(),
  extra_50gb_units: z.number().int(),
  custom_member_limit: z.number().int().nullable().default(null),
  custom_attachment_quota_bytes: z.number().int().nullable().default(null),
});

// チーム用の組織の契約（プラン、個別の標準値、支払いの周期）を書く（docs/data-model.md の「書き込みの単位」の契約の変更）。
// 契約の行を書き、同じ batch() で organizations の人数と添付ファイルの上限を契約から決まる値にし、お試しの期限を空にする
// （有料のプランにしたらお試しを終える）。停止中の組織も書けるが、再開はしない。
// expected は画面が見ていた前の契約（未契約なら null）。今の契約がそれと違えば（確認を開いた後に別の運用者が変えた）409 の conflict。
// 今の契約が送った値と同じで、上限が契約から決まる値と一致すれば何も書かず、今の値を返す。自分用の組織は 409 の conflict（reason: personal_organization）、無い slug は 404。
// 解約で消す予定日を過ぎた組織は、消している途中で契約の行を足さないよう 409 の purge_due（境目は再開と同じ）。
// 履歴は action が update で、変わった列の前後の値を残す。契約を変えたときはプランと支払いの周期を組で残す。履歴を書けなくても変更は成功として返す
export const organizationPlanUpdate = defineOperation({
  name: 'organization-plan-update',
  description:
    'チーム用の組織の契約（スモール、チーム、ビジネス、プロ、個別と支払いの周期）を変え、人数と添付ファイルの上限を契約から決め、お試しを終える。個別は人数とGB整数の標準容量を指定する。expected は画面が見ていた前の契約（未契約なら null）で、今の契約と違えば 409。消す予定日を過ぎた解約の組織は 409 の purge_due',
  mode: 'write',
  permission: 'operator',
  input: z
    .object({
      slug: z.string().max(SLUG_MAX_LENGTH * 2),
      plan: z.enum(teamPlans),
      billing_interval: z.enum(billingIntervals),
      custom_member_limit: z.number().int().min(1).max(MEMBER_LIMIT_MAX).nullable().optional(),
      custom_attachment_quota_bytes: z
        .number()
        .int()
        .min(QUOTA_GIB)
        .max(ATTACHMENT_QUOTA_MAX_BYTES)
        .multipleOf(QUOTA_GIB)
        .nullable()
        .optional(),
      // 追加容量の操作を入れる前のクライアントは口数を送らない。省略は0口として受け、現在が追加容量ありなら競合にする。
      expected: organizationContract
        .extend({
          extra_10gb_units: z.number().int().default(0),
          extra_50gb_units: z.number().int().default(0),
        })
        .nullable(),
    })
    .superRefine((value, ctx) => {
      for (const key of ['custom_member_limit', 'custom_attachment_quota_bytes'] as const) {
        if (value.plan === 'custom' ? value[key] == null : value[key] != null) {
          ctx.addIssue({ code: 'custom', path: [key], message: '個別契約のときだけ標準値を指定してください' });
        }
      }
    }),
  output: z.object({
    slug: z.string(),
    contract: organizationContract,
    member_limit: z.number().int(),
    attachment_quota_bytes: z.number().int(),
    trial_ends_on: z.string().nullable(),
  }),
});
