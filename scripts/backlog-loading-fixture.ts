// seed の member セッションで読む、使い捨て D1 専用の架空データ。
const id = (kind: number, row = 1) => `019e${kind}000-0000-7000-8000-${String(row).padStart(12, '0')}`;
export const backlogSlug = 'bench-backlog-loading';
export const backlogActorId = id(2);
export const backlogWorkspaceId = id(3);
export const backlogEmptyWorkspaceId = id(3, 2);
export const backlogCategoryId = id(5);
export const backlogRepositoryId = id(6);
export const backlogTaskCount = 100;
const targetTaskId = id(9, 10); // 親なしで、初回描画から操作できる行。
type BacklogCase = {
  name: string;
  workspaceId: string;
  query: Record<string, string>;
  input: Record<string, string>;
  hasTask: boolean;
  targetTaskId: string | null;
};
export const backlogCases: readonly BacklogCase[] = [
  { name: '絞り込みなし', workspaceId: backlogWorkspaceId, query: {}, input: {}, hasTask: true, targetTaskId },
  {
    name: '自分と検索一致',
    workspaceId: backlogWorkspaceId,
    query: { assignee: 'me', q: '計測対象' },
    input: { assignee_user_id: 'me', query: '計測対象' },
    hasTask: true,
    targetTaskId,
  },
  {
    name: '区分とリポジトリ一致',
    workspaceId: backlogWorkspaceId,
    query: { category: backlogCategoryId, repository: backlogRepositoryId },
    input: { category_id: backlogCategoryId, repository_id: backlogRepositoryId },
    hasTask: true,
    targetTaskId,
  },
  {
    name: '本当に空の作業場',
    workspaceId: backlogEmptyWorkspaceId,
    query: {},
    input: {},
    hasTask: false,
    targetTaskId: null,
  },
  {
    name: '検索該当なし',
    workspaceId: backlogWorkspaceId,
    query: { q: '存在しない検索語' },
    input: { query: '存在しない検索語' },
    hasTask: false,
    targetTaskId: null,
  },
];
export function backlogPath(index: number): string {
  const selected = backlogCases[index];
  if (!selected) throw new Error('バックログの計測条件がありません');
  const query = new URLSearchParams(selected.query).toString();
  return `/${backlogSlug}/w/${selected.workspaceId}${query ? `?${query}` : ''}`;
}

export function backlogLoadingFixture(): string {
  const at = '2026-11-16T00:00:00.000Z';
  const org = id(1),
    actor = backlogActorId,
    creator = id(2, 2),
    ws = backlogWorkspaceId;
  let sql = `
INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) VALUES
 ('${org}', '${backlogSlug}', '計測の工房', 'github:9000000000000001', '${at}', '${at}');
INSERT INTO users (id, organization_id, account_id, login_provider, login_subject, name, is_admin, created_at, updated_at) VALUES
 ('${actor}', '${org}', '019a0000-0000-7000-8000-000000000102', 'github', '9000000000000102', 'ハルカ', 0, '${at}', '${at}'),
 ('${creator}', '${org}', '019a0000-0000-7000-8000-000000000101', 'github', '9000000000000101', 'ミナト', 1, '${at}', '${at}');
`;
  for (const [index, workspace] of [ws, backlogEmptyWorkspaceId].entries()) {
    sql += `INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at) VALUES
 ('${workspace}', '${org}', '計測の作業場 ${index}', 'Asia/Tokyo', '${creator}', '${at}', '${at}');
INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, joined_at) VALUES
 ('${id(4, index + 1)}', '${workspace}', '${actor}', 'member', '2026-11-16', '${at}');\n`;
  }
  sql += `INSERT INTO categories (id, workspace_id, name, is_billed_monthly, position, created_at, updated_at) VALUES
 ('${backlogCategoryId}', '${ws}', '計測の区分', 0, 'a0', '${at}', '${at}');
INSERT INTO repositories (id, workspace_id, name, position, created_at, updated_at) VALUES
 ('${backlogRepositoryId}', '${ws}', 'bench-work', 'a0', '${at}', '${at}');
INSERT INTO epics (id, workspace_id, title, category_id, reward_tier, requester_user_id, created_by, position, created_at, updated_at)
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2)
 SELECT printf('019e7000-0000-7000-8000-%012d', i), '${ws}', '計測の目標 ' || i, '${backlogCategoryId}', 'small', '${creator}', '${creator}', printf('a0%03dV', i), '${at}', '${at}' FROM n;
INSERT INTO stories (id, workspace_id, epic_id, title, created_by, position, created_at, updated_at)
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4)
 SELECT printf('019e8000-0000-7000-8000-%012d', i), '${ws}', printf('019e7000-0000-7000-8000-%012d', (i-1)%2+1), '計測のまとまり ' || i, '${creator}', printf('a0%03dV', i), '${at}', '${at}' FROM n;
INSERT INTO tasks (id, workspace_id, is_imported, tray, title, story_id, category_id, repository_id, assignee_user_id, points, position, created_by, created_at, updated_at)
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${backlogTaskCount})
 SELECT printf('019e9000-0000-7000-8000-%012d', i), '${ws}', 0, 'backlog',
 CASE WHEN i%10=0 THEN '計測対象 ' ELSE 'バックログの作業 ' END || i,
 CASE WHEN i%5<>0 THEN printf('019e8000-0000-7000-8000-%012d', (i-1)%4+1) END,
 CASE WHEN i%10=0 THEN '${backlogCategoryId}' END,
 CASE WHEN i%2=0 THEN '${backlogRepositoryId}' END,
 CASE WHEN i%2=0 THEN '${actor}' END, 1, printf('a0%04dV', i), '${creator}', '${at}', '${at}' FROM n;
`;
  return sql;
}
