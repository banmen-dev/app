// プロフィール画像を配る URL（/api/<slug>/user-avatar/<画像の ID>）。URL の形は操作の定義（operationPath）から作る
import { operationPath } from '../../shared/operations/define.ts';
import { userAvatar } from '../../shared/operations/organization/me-avatar.ts';

export function avatarUrl(slug: string, avatarId: string): string {
  return operationPath(userAvatar, slug, { id: avatarId });
}

// R2 のキー。組織の接頭辞の下に置くので、組織を消す手順で接頭辞ごと消える。末尾は user_avatars.id と同じ値（表の CHECK が揃える）
export function avatarObjectKey(organizationId: string, userId: string, avatarId: string): string {
  return `${organizationId}/avatars/${userId}/${avatarId}`;
}
