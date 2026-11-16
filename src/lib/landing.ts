// ログインの直後は全組織のダッシュボード。入れる組織も招待も無い運用者だけ運用の画面へ。
export type Landing = { to: 'operator' } | { to: 'select' };

export function landingFor(account: {
  organizations: readonly { slug: string }[];
  invitations: readonly unknown[];
  operator: boolean;
}): Landing {
  if (account.invitations.length > 0) return { to: 'select' };
  if (account.organizations.length === 0 && account.operator) return { to: 'operator' };
  return { to: 'select' };
}
