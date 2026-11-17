import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { accountOrganizationSchema } from './my-today.ts';
import {
  RECENT_ACTIVITY_PAGE_SIZE,
  RECENT_ACTIVITY_WORKSPACE_LIMIT,
  recentActivityEntrySchema,
} from './recent-activity.ts';

const organizationSchema = accountOrganizationSchema;
const cursorSchema = z.object({ created_at: z.iso.datetime({ precision: 3 }), id: idSchema });

// 全組織のダッシュボード（/）の「最近の更新」。組織のホームの recent-activity の決まり（範囲、出さない履歴、本文の長さ、並び）を、入れるすべての組織に広げる。
// 組織ごとの行を created_at と id の新しい順に混ぜて 20 件ずつ返し、続きは前のページの最後の行を before に渡す（ID は UUIDv7 で、組織をまたいでも順が決まる）。
// 読む組織は my-today と同じ（自分用を先に、残りを名前順に 10 組織まで。超えた数を omitted_organizations、読めなかった組織を failed_organizations に返す）。
// 所属するワークスペースの上限（RECENT_ACTIVITY_WORKSPACE_LIMIT）は全組織の合計に当て、読んだ組織の順、組織の中は新しく作った順に数える。
// 上限で1つも読めなくなった組織も omitted_organizations に数える（画面が「ほか N 組織は読み込んでいません」と出す）。
// 各行に組織を添える。した人の名前は、その組織での今の名前
export const myRecentActivity = defineOperation({
  name: 'my-recent-activity',
  description: `入れる組織の、所属する閉じていないワークスペースのタスク、ストーリー、エピックの変更とコメントを、組織をまたいで新しい順に ${RECENT_ACTIVITY_PAGE_SIZE} 件ずつ返す。ワークスペースは全組織で ${RECENT_ACTIVITY_WORKSPACE_LIMIT} 個まで読む`,
  mode: 'read',
  permission: 'login',
  input: z.object({ before: cursorSchema.optional() }),
  output: z.object({
    entries: z.array(recentActivityEntrySchema.extend({ organization: organizationSchema })),
    next: cursorSchema.nullable(),
    omitted_organizations: z.number().int().nonnegative(),
    failed_organizations: z.array(organizationSchema),
  }),
});

export type MyRecentActivityEntry = z.output<typeof myRecentActivity.output>['entries'][number];
