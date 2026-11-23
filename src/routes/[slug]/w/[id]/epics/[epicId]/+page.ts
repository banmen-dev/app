import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../../../lib/login-redirect.ts';
import { epicDetail } from '../../../../../../shared/operations/epic/index.ts';
import type { PageLoad } from './$types';

// エピックの画面が使う値。エピックが無いとき（別の組織、別のワークスペース、削除済み、形の合わない ID）は notFound が真で、
// 読めなかったとき（通信、5xx）は detail が null で notFound が偽、画面は読み込みの失敗を出す。
// ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ失敗に畳む。
// 区分の選択肢はここで読まない。画面に出す区分名は epic-detail の値で、選択肢は「直す」の引き出し（EpicDrawer）が開いたときに読む（#1058）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:epic-detail` は、引き出しで直した後に、この画面の値だけを読み直す印（枠の load を走らせない）
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:epic-detail');
  const options = { slug: params.slug, fetcher: fetch };
  const result = await callOperation(epicDetail, { workspace_id: params.id, epic_id: params.epicId }, options);
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  return {
    detail: result.ok ? result.data : null,
    notFound: !result.ok && (result.status === 404 || result.status === 400),
  };
};
