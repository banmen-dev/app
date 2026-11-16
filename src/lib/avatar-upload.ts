import type { ApiResult } from './api.ts';
import { isErrorBody } from '../shared/errors.ts';
import { meAvatarUpload } from '../shared/operations/organization/me-avatar.ts';
import { operationPath } from '../shared/operations/define.ts';
import { notifyOperationWrite } from './operation-events.ts';
import { redirectOrganizationReauth } from './login-redirect.ts';

export async function uploadAvatar(
  blob: Blob,
  slug: string,
  fetcher: typeof fetch = fetch,
): Promise<ApiResult<{ avatar_url: string }>> {
  try {
    const response = await fetcher(operationPath(meAvatarUpload, slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Operation-Input': encodeURIComponent('{}') },
      body: blob,
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = meAvatarUpload.output.safeParse(body);
      if (!parsed.success) return { ok: false, status: response.status, error: null };
      notifyOperationWrite({ name: meAvatarUpload.name, slug });
      return { ok: true, data: parsed.data };
    }
    const error = isErrorBody(body) ? body.error : null;
    redirectOrganizationReauth(slug, response.status, error?.code);
    return { ok: false, status: response.status, error };
  } catch {
    return { ok: false, status: 0, error: null };
  }
}
