import type { ApiResult } from './api.ts';
import { memberLimitDetailsOf } from './member-limit-details.ts';
import { t } from './vocabulary.svelte.ts';
import { workspaceLimitDetailsOf } from './workspace-limit-details.ts';

export function workspaceReopenRefusal(
  result: Extract<ApiResult<never>, { ok: false }>,
  name: string,
  source: 'list' | 'settings',
): string | null {
  if (result.status !== 409) return null;
  const workspace = t('workspace');
  if (result.error?.code === 'workspace_limit_reached') {
    const limit = workspaceLimitDetailsOf(result.error.details);
    const guidance =
      source === 'list'
        ? t('workspaceReopenFindSpaceHere', { workspace })
        : t('workspaceReopenFindSpaceElsewhere', { workspace, adminPage: t('pageOrgAdmin') });
    return limit === undefined
      ? t('workspaceReopenWorkspaceLimitUnknown', { name, workspace, guidance })
      : t('workspaceReopenWorkspaceLimit', { name, workspace, guidance, ...limit });
  }
  if (result.error?.code === 'member_limit_reached') {
    const seats = memberLimitDetailsOf(result.error.details);
    const words = {
      name,
      workspace,
      organization: t('organization'),
      adminPage: t('pageOrgAdmin'),
      users: t('userSectionTitle'),
    };
    return seats === undefined
      ? t('workspaceReopenMemberLimitUnknown', words)
      : t('workspaceReopenMemberLimit', { ...words, ...seats });
  }
  return null;
}
