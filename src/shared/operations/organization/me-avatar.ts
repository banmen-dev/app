// 自分のプロフィール画像（Issue #1265）。組織ごとに1人1枚。上げる・外す操作は入力に人の ID を持たず、呼んだ本人の行だけを触る。
// 配る操作は画像の ID で引き、同じ組織の人に返す
import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 本文の上限（512KiB）。user_avatars.size_bytes の CHECK と同じ値
export const AVATAR_MAX_BYTES = 524_288;
// 縦と横の上限（px）
export const AVATAR_MAX_PIXELS = 512;

export const meAvatarUpload = defineOperation({
  name: 'me-avatar-upload',
  description:
    '自分のプロフィール画像を上げる（PNG、JPEG、WebP。512KiB、512px まで。動く画像は断る）。本文は画像のバイト、入力の JSON はヘッダー X-Operation-Input。配る URL を返す',
  permission: 'organization',
  mode: 'write',
  body: 'binary',
  maxBodyBytes: AVATAR_MAX_BYTES,
  rateLimit: { max: 20, windowSeconds: 600 },
  input: z.object({}),
  output: z.object({ avatar_url: z.string() }),
});

export const meAvatarDelete = defineOperation({
  name: 'me-avatar-delete',
  description:
    '自分のプロフィール画像を外す。画像が無くても成功する。外した後のアバター（ログインの手段のアイコンか null）を返す',
  permission: 'organization',
  mode: 'write',
  storage: 'attachments',
  input: z.object({}),
  output: z.object({ avatar_url: z.string().nullable() }),
});

export const userAvatar = defineOperation({
  name: 'user-avatar',
  description: '組織の人のプロフィール画像を、画像の ID で返す',
  permission: 'organization',
  mode: 'read',
  response: 'binary',
  cacheControl: 'private, max-age=3600',
  input: z.object({ id: idSchema }),
  output: z.instanceof(Response),
});
