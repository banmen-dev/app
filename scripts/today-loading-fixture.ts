import { z } from 'zod';

// 使い捨て D1 にだけ追加する架空データ。seed の公開セッション（member）で全条件を読む。
export const todayCases = [
  { role: 'member', pending: true },
  { role: 'member', pending: false },
  { role: 'leader', pending: true },
  { role: 'leader', pending: false },
  { role: 'admin', pending: true },
  { role: 'admin', pending: false },
] as const;
export function todayCaseSlug(index: number) {
  return `bench-today-${index}`;
}
const id = (index: number, kind: number, row = 1) =>
  `019d${index}${kind}00-0000-7000-8000-${String(row).padStart(12, '0')}`;
export function todayLoadingFixture(now = new Date()): string {
  const at = now.toISOString();
  return todayCases
    .map(({ role, pending }, i) => {
      const org = id(i, 1),
        actor = id(i, 2),
        creator = id(i, 3),
        ws = id(i, 4);
      let sql = `
INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) VALUES
 ('${org}', '${todayCaseSlug(i)}', '計測用 ${i}', 'github:9000000000000001', '${at}', '${at}');
INSERT INTO users (id, organization_id, account_id, login_provider, login_subject, name, is_admin, created_at, updated_at) VALUES
 ('${actor}', '${org}', '019a0000-0000-7000-8000-000000000102', 'github', '9000000000000102', 'ハルカ', ${role === 'admin' ? 1 : 0}, '${at}', '${at}'),
 ('${creator}', '${org}', '019a0000-0000-7000-8000-000000000101', 'github', '9000000000000101', 'ミナト', 1, '${at}', '${at}');
`;
      if (role === 'admin' && pending) return sql;
      sql += `INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at) VALUES
 ('${ws}', '${org}', '計測の作業場', 'Asia/Tokyo', '${creator}', '${at}', '${at}');\n`;
      if (role === 'admin') return sql; // 管理者は作業場を作ると必須完了。所属なしなのでタスクは空。
      sql += `INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, joined_at) VALUES
 ('${id(i, 5)}', '${ws}', '${actor}', '${role}', '${at.slice(0, 10)}', '${at}');\n`;
      if (role === 'leader' && pending) return sql; // バックログに1件でもあれば必須完了になる。
      sql += `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, assignee_user_id, today_on, points, position, created_by, created_at, updated_at)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
SELECT printf('019d${i}600-0000-7000-8000-%012d', i), '${ws}', 0, 'backlog', '計測のタスク ' || i,
 '${actor}', CASE WHEN i <= 30 THEN '${at.slice(0, 10)}' END, 1, printf('a0%06dV', i), '${pending ? creator : actor}', '${at}', '${at}' FROM n;\n`;
      return sql;
    })
    .join('\n');
}

export function todayFixtureAt(value: string): Date {
  const parsed = z.iso.datetime({ offset: true }).safeParse(value);
  if (!parsed.success) throw new Error('--fixture-at にタイムゾーン付きの有効なISO日時を指定してください');
  const at = new Date(parsed.data);
  if (!Number.isFinite(at.getTime())) throw new Error('--fixture-at に有効なISO日時を指定してください');
  return at;
}
