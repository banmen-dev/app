import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
import { firstSteps, recentActivity, today } from '../../shared/operations/organization/index.ts';
import type { PageLoad } from './$types';

// today が null のときは読めなかったこと（空の一覧とは別）で、画面は読み込みの失敗を出す。
// firstSteps は today とは別の操作で、画面が2回呼ぶ。null（読めなかった）のときと、手順が空のときは、最初にやることの面を置かない。
// recentActivity（最近の更新の面）も別の操作で、読めなかったとき（null）は、ホーム全体ではなく、その面だけを失敗の案内にする
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  // 印の付け外し、完了、戻すの後に、今日の読み取りと最初にやること、最近の更新を読み直す
  depends('app:today');
  const [todayResult, firstStepsResult, activityResult] = await Promise.all([
    callOperation(today, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(firstSteps, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(recentActivity, {}, { slug: params.slug, fetcher: fetch }),
  ]);
  if (isUnauthenticated(todayResult) || isUnauthenticated(firstStepsResult) || isUnauthenticated(activityResult))
    redirect(307, loginUrl(url));
  return {
    today: todayResult.ok ? todayResult.data : null,
    firstSteps: firstStepsResult.ok ? firstStepsResult.data : null,
    recentActivity: activityResult.ok ? activityResult.data : null,
  };
};
