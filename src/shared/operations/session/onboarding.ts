import { z } from 'zod';
import { accountProfileSchema } from '../../account-profile.ts';
import { defineOperation } from '../define.ts';

export const accountProfileSave = defineOperation({
  name: 'account-profile-save',
  description: '自分の表示する名前と肩書きを保存する。新しく作る組織の最初の管理者にはこの名前を使う',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: accountProfileSchema,
  output: accountProfileSchema,
});

export const onboardingStatus = defineOperation({
  name: 'onboarding-status',
  description: '自分のプロフィールと自分用の組織を返す。導入フローを再開するために使う',
  mode: 'read',
  permission: 'login',
  cookieOnly: true,
  input: z.object({}),
  output: z.object({
    profile: accountProfileSchema.nullable(),
    personal: z.object({ slug: z.string(), available: z.boolean() }).nullable(),
  }),
});
