// 全組織のダッシュボードの操作（my-workspaces、my-recent-activity）のテストが使う、本人が入る組織を作る関数
import {
  createMembership,
  createOrganization,
  createPersonalOrganizationRow,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';
import type { Person } from './operations/world.ts';

export type DashboardOrganizationOptions = {
  name?: string;
  suspended?: boolean;
  disabled?: boolean;
  admin?: boolean;
  join?: boolean;
  personal?: boolean;
  workspaceName?: string;
  credentialsNotBefore?: string | null;
};

// 本人のユーザーと、本人が所属するワークスペースを1つ持つ組織
export async function organizationFor(person: Person, options: DashboardOrganizationOptions = {}) {
  const overrides = {
    name: options.name ?? '青葉工房',
    suspended_at: options.suspended ? '2026-11-01T00:00:00.000Z' : null,
  };
  const organization = options.personal
    ? await createPersonalOrganizationRow(person.accountId, overrides)
    : await createOrganization(overrides);
  const user = await createUser(organization, {
    account_id: person.accountId,
    login_provider: person.login.provider,
    login_subject: person.login.subject,
    is_admin: options.admin ? 1 : 0,
    disabled_at: options.disabled ? '2026-11-01T00:00:00.000Z' : null,
    credentials_not_before: options.credentialsNotBefore ?? null,
  });
  const workspace = await createWorkspace(organization, user.id, {
    name: options.workspaceName ?? `${organization.name}の班`,
  });
  if (options.join !== false) await createMembership(organization, workspace.id, user.id);
  return { organization, user, workspace };
}

export function organizationRef(organization: OrganizationFixture) {
  return { slug: organization.slug, name: organization.name, kind: organization.kind };
}
