import { attachmentDelete } from '../../shared/operations/attachment/index.ts';
import type { AnyOperationDefinition } from '../../shared/operations/define.ts';
import { meAvatarDelete } from '../../shared/operations/organization/me-avatar.ts';
import { previewBranchNumber } from '../../shared/preview-branch.ts';
import { isIsolatedPreviewSubdomain, PREVIEW_ORIGIN_PATTERN, previewOrigin } from '../../shared/preview-cloudflare.ts';
import { ApiError } from '../errors.ts';

export function isPreviewWithoutAttachments(
  env: Pick<Env, 'PUBLIC_ORIGIN'> & { PREVIEW_WITHOUT_ATTACHMENTS?: string },
): boolean {
  if (env.PREVIEW_WITHOUT_ATTACHMENTS !== '1') return false;
  const match = PREVIEW_ORIGIN_PATTERN.exec(env.PUBLIC_ORIGIN);
  const issue = match && previewBranchNumber(`${match[1]}-preview`);
  const subdomain = match?.[2];
  return !!issue && isIsolatedPreviewSubdomain(subdomain) && env.PUBLIC_ORIGIN === previewOrigin(issue, subdomain);
}

export function checkAttachmentAvailability(
  previewWithoutAttachments: boolean,
  definition: AnyOperationDefinition,
  input: unknown,
): void {
  if (!previewWithoutAttachments) return;
  if (
    definition.body === 'binary' ||
    definition.response === 'binary' ||
    definition.name === attachmentDelete.name ||
    definition.name === meAvatarDelete.name ||
    (typeof input === 'object' &&
      input !== null &&
      'attachment_ids' in input &&
      Array.isArray(input.attachment_ids) &&
      input.attachment_ids.length > 0)
  ) {
    throw new ApiError(503, 'unavailable');
  }
}
