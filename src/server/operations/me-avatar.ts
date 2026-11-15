// 自分のプロフィール画像の操作の処理（定義は src/shared/operations/organization/me-avatar.ts。Issue #1265）。
// 入れ物だけ。処理は後で書く
import { meAvatarDelete, meAvatarUpload, userAvatar } from '../../shared/operations/organization/index.ts';
import { implement } from './implement.ts';

export const meAvatarUploadOperation = implement(meAvatarUpload, async () => {
  throw new Error('未実装');
});

export const meAvatarDeleteOperation = implement(meAvatarDelete, async () => {
  throw new Error('未実装');
});

export const userAvatarOperation = implement(userAvatar, async () => {
  throw new Error('未実装');
});
