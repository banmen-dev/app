import type { z } from 'zod';
import { RECENT_ACTIVITY_WORKSPACE_LIMIT } from '../../shared/operations/organization/recent-activity.ts';
import { myRecentActivity } from '../../shared/operations/organization/my-recent-activity.ts';
import { reportOrganizationReadFailure } from '../db/index.ts';
import type { AccountOrganizationReader } from './account.ts';
import { implement } from './implement.ts';
import {
  pageOfEntries,
  readMemberWorkspaces,
  readRecentActivityEntries,
  type MemberWorkspace,
} from './recent-activity.ts';

type View = z.output<typeof myRecentActivity.output>;
type Cursor = { created_at: string; id: string };

// 全組織のダッシュボードの「最近の更新」（my-recent-activity）。組織のホームの recent-activity と同じ文で、組織ごとに読んで混ぜる。
// 手順:
//   1. 入れる組織ごとに（名前順に 10 組織まで）、所属する閉じていないワークスペースを新しく作った順に引く（組織をまたぐのは渡された読み取りだけ）
//   2. ワークスペースの上限（50）を全組織の合計に当てる。読んだ組織の順（自分用を先に、残りは名前の順）に、組織の中は新しく作った順に数え、超えた分は読まない
//      （1回の読み取りの文の数を、組織のホームと同じ上限に保つ）。上限で1つも読めなくなった組織は omitted_organizations に足す
//   3. 組織ごとに、残ったワークスペースの変更とコメントを1回の batch で読み、全組織の分を created_at と id の新しい順に混ぜて 20 件に切る
// 1 の読み取りが失敗した組織と、3 の読み取りが失敗した組織は、どちらも読めなかった組織として返し、ほかの組織の分は返す。
// 3 は 1 で認可を通した入口だけを使う（入口は 1 の callback が作る読み取りの関数の中に閉じ、外へは返さない）
export async function readAccountRecentActivity(
  read: AccountOrganizationReader,
  before: Cursor | undefined,
): Promise<View> {
  const listed = await read(async (db, userId) => {
    const workspaces = await readMemberWorkspaces(db, userId);
    const organizationId = db.organizationId;
    return {
      workspaces,
      organizationId,
      entries: (subset: readonly MemberWorkspace[]) => readRecentActivityEntries(db, subset, before),
    };
  });

  let remaining = RECENT_ACTIVITY_WORKSPACE_LIMIT;
  // 上限で1つも読めなくなった組織（所属はあるのに、前の組織で枠を使い切った）は、読まなかった組織に数える
  let capped = 0;
  const plans = listed.organizations.map(({ organization, data }) => {
    const subset = data.workspaces.slice(0, Math.max(0, remaining));
    remaining -= subset.length;
    if (subset.length === 0 && data.workspaces.length > 0) capped++;
    return { organization, data, subset };
  });
  // 上限で1つも読めなくなった組織は2段目を呼ばない（読まなかった組織と読めなかった組織の両方に数えないため）
  const results = await Promise.allSettled(
    plans.map(({ data, subset }) => (subset.length === 0 ? Promise.resolve([]) : data.entries(subset))),
  );

  const found: View['entries'] = [];
  const failed_organizations = [...listed.failed_organizations];
  results.forEach((result, index) => {
    const { organization, data } = plans[index]!;
    if (result.status === 'fulfilled') {
      for (const entry of result.value) found.push({ ...entry, organization });
    } else {
      failed_organizations.push(organization);
      reportOrganizationReadFailure(data.organizationId, result.reason);
    }
  });

  return {
    ...pageOfEntries(found),
    omitted_organizations: listed.omitted_organizations + capped,
    // 1 で読めなかった組織、3 で読めなかった組織の順（どちらも読んだ組織の順のまま）
    failed_organizations,
  };
}

export const myRecentActivityOperation = implement(myRecentActivity, async ({ account, input }) =>
  account.recentActivity(input.before),
);
