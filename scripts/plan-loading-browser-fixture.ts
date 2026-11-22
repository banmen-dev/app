import { loadingEpic, loadingFixtureSql, loadingWorkspace } from './loading-fixture.ts';
import { emptyPlanSql, emptyPlanWorkspace } from './plan-loading-comparison.ts';

const seedWorkspacePrefix = '019b1';
const seedWorkspaceWikiPrefix = '019c0001';
const plannedPrefix = '019b3';
const closedPrefix = '019b4';
const slug = 'aoba';
const summaryEpicTitle = '大きな目標 1';
const plannedLaneTitle = '先の計測';
const plannedLaneId = '019b3p00-0000-7000-8000-000000000005';
const activeLaneId = '019b1p00-0000-7000-8000-000000000001';
const activeTaskId = '019b1t00-0000-7000-8000-000000000056';
const plannedTaskId = '019b3t00-0000-7000-8000-000000000200';
const velocitySprintId = '019b1p00-0000-7000-8000-000000000002';

const cloneId = (id: string, prefix: string) => id.replace(seedWorkspacePrefix, prefix);

export type PlanBrowserFixture = {
  key: 'history' | 'planned' | 'empty' | 'closed';
  slug: string;
  workspaceId: string;
  laneId: string | null;
  laneTitle: string | null;
  taskId: string | null;
  summaryEpicId: string | null;
  summaryEpicTitle: string | null;
  velocitySprintId: string | null;
};

export const planBrowserFixtures: readonly PlanBrowserFixture[] = [
  {
    key: 'history',
    slug,
    workspaceId: loadingWorkspace,
    laneId: activeLaneId,
    laneTitle: '計測',
    taskId: activeTaskId,
    summaryEpicId: loadingEpic,
    summaryEpicTitle,
    velocitySprintId,
  },
  {
    key: 'planned',
    slug,
    workspaceId: cloneId(loadingWorkspace, plannedPrefix),
    laneId: plannedLaneId,
    laneTitle: plannedLaneTitle,
    taskId: plannedTaskId,
    summaryEpicId: cloneId(loadingEpic, plannedPrefix),
    summaryEpicTitle,
    velocitySprintId: cloneId(velocitySprintId, plannedPrefix),
  },
  {
    key: 'empty',
    slug,
    workspaceId: emptyPlanWorkspace,
    laneId: null,
    laneTitle: null,
    taskId: null,
    summaryEpicId: null,
    summaryEpicTitle: null,
    velocitySprintId: null,
  },
  {
    key: 'closed',
    slug,
    workspaceId: cloneId(loadingWorkspace, closedPrefix),
    laneId: cloneId(activeLaneId, closedPrefix),
    laneTitle: '計測',
    taskId: cloneId(activeTaskId, closedPrefix),
    summaryEpicId: cloneId(loadingEpic, closedPrefix),
    summaryEpicTitle,
    velocitySprintId: cloneId(velocitySprintId, closedPrefix),
  },
];

// #1253 と同じデータ量と履歴を保つ。元のワークスペースに属する文だけを複製し、組織の請求管理者や
// 組織の Wiki は、同じ組織にまとめて一度だけ入れる。SQL と ID はこのリポジトリの固定値を使う。
function copyWorkspaceSql(source: string, prefix: string, wikiPrefix: string): string {
  const statements = source.split(/;\r?\n/).filter((statement) => statement.includes(loadingWorkspace));
  return (
    statements
      .map((statement) =>
        statement.replaceAll(seedWorkspacePrefix, prefix).replaceAll(seedWorkspaceWikiPrefix, wikiPrefix),
      )
      .join(';\n') + ';\n'
  );
}

export function planBrowserFixtureSql(at: Date): string {
  const base = loadingFixtureSql(at);
  const stamp = at.toISOString();
  const plannedWorkspace = cloneId(loadingWorkspace, plannedPrefix);
  const closedWorkspace = cloneId(loadingWorkspace, closedPrefix);
  const plannedColumn = '019b3b00-0000-7000-8000-000000000001';
  return (
    base +
    emptyPlanSql +
    copyWorkspaceSql(base, plannedPrefix, '019c0003') +
    copyWorkspaceSql(base, closedPrefix, '019c0004') +
    `
INSERT INTO sprints (id, workspace_id, name, start_on, end_on, status, created_at, updated_at)
VALUES ('${plannedLaneId}', '${plannedWorkspace}', '${plannedLaneTitle}',
  date('${stamp}', '+14 days'), date('${stamp}', '+27 days'), 'planned', '${stamp}', '${stamp}');
UPDATE tasks SET sprint_id = '${plannedLaneId}', column_id = '${plannedColumn}', column_position = position
WHERE workspace_id = '${plannedWorkspace}' AND rowid IN (
  SELECT rowid FROM tasks WHERE workspace_id = '${plannedWorkspace}' AND completed_at IS NULL AND sprint_id IS NULL
  ORDER BY position, id LIMIT 30
);
UPDATE workspaces SET closed_at = '${stamp}', updated_at = '${stamp}' WHERE id = '${closedWorkspace}';
`
  );
}
