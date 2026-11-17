import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { accountOrganizationSchema } from './my-today.ts';

const organizationSchema = accountOrganizationSchema;

// 全組織のダッシュボード（/）の自分用の面と組織の面に並べる、組織ごとの自分のワークスペース。
// 範囲は組織のホームのワークスペースの面と同じで、今所属する閉じていないワークスペースだけ（管理者でも、所属していないものは返さない）。
// 組織の中は名前の順（同名は ID の順）。読む組織と上限、1組織の失敗の扱いは my-today と同じ（自分用を先に、残りを名前順に 10 組織まで。超えた数を omitted_organizations、
// 読めなかった組織を failed_organizations に返す）。me_id はその組織での自分のユーザーの ID（自分用にワークスペースを作るダイアログが、最初のリーダーの既定に使う）
export const myWorkspaces = defineOperation({
  name: 'my-workspaces',
  description: '入れる組織ごとに、自分が今所属する閉じていないワークスペースを名前の順に返す',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({
    organizations: z.array(
      z.object({
        organization: organizationSchema,
        me_id: idSchema,
        workspaces: z.array(z.object({ id: idSchema, name: z.string(), role: z.enum(['leader', 'member']) })),
      }),
    ),
    omitted_organizations: z.number().int().nonnegative(),
    failed_organizations: z.array(organizationSchema),
  }),
});
