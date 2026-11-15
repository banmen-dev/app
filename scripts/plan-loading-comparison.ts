import { loadingWorkspace } from './loading-fixture.ts';
import type { Reading } from './loading-screens.ts';
import { readTrial, type ReadResponse } from './loading-trial.ts';
import { percentile, trialTiming } from './loading-stats.ts';

export const planConditions = ['A', 'B', 'C'] as const;
export type PlanCondition = (typeof planConditions)[number];
export function planComparisonOptions(args: readonly string[]) {
  const enabled = args.includes('--plan-compare');
  const reverse = args.includes('--comparison-reverse');
  if (enabled && (args.includes('--layout-only') || args.includes('--layout-before'))) {
    throw new Error('--plan-compare と layout の指定は併用できません');
  }
  if (reverse && !enabled) throw new Error('--comparison-reverse には --plan-compare が必要です');
  return { enabled, conditions: reverse ? [...planConditions].reverse() : [...planConditions] };
}

export function planTimingCell(
  samples: readonly { primary: number; ready: number; total: number }[],
  key: 'primary' | 'ready' | 'total',
): string {
  const values = samples.map((sample) => sample[key]);
  return `${percentile(values, 0.5).toFixed(2)} / ${percentile(values, 0.95).toFixed(2)}`;
}
export const emptyPlanWorkspace = '019b2000-0000-7000-8000-000000000001';

// loadingFixtureSql と同じ組織・利用者の空のワークスペース。既存の D1 には適用しない。
export const emptyPlanSql = `
INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at)
SELECT '${emptyPlanWorkspace}', organization_id, '空の計画の計測', timezone, created_by, created_at, updated_at
FROM workspaces WHERE id='${loadingWorkspace}';
INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, joined_at)
SELECT CASE role WHEN 'leader' THEN '019b2m00-0000-7000-8000-000000000001'
ELSE '019b2m00-0000-7000-8000-000000000002' END,
'${emptyPlanWorkspace}', user_id, role, joined_on, joined_at
FROM memberships WHERE workspace_id='${loadingWorkspace}';
`;

// 全応答を回収・検査してから次の試行へ進む。C でも従を次の試行に持ち越さない。
// ready は API の依存関係のモデルであり、実際の PageLoad や描画時間ではない。
export async function readPlanComparison(
  condition: PlanCondition,
  workspaceId: string,
  reverse: boolean,
  read: (operation: Reading) => Promise<ReadResponse>,
  now: () => number = () => performance.now(),
) {
  const operations: Reading[] = [
    { name: 'sprint-list', secondary: false, global: false, input: { workspace_id: workspaceId } },
    ...(condition === 'A'
      ? []
      : [{ name: 'plan-summary', secondary: true, global: false, input: { workspace_id: workspaceId } }]),
  ];
  const responses = await readTrial(operations, [], reverse, read, now);
  const timing = trialTiming(
    responses.map((response) => ({ ms: response.completedMs, secondary: response.secondary })),
  );
  return { primary: timing.primary, ready: condition === 'B' ? timing.total : timing.primary, total: timing.total };
}
