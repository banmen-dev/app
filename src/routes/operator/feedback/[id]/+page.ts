import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { callOperation } from '../../../../lib/api.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../../../../lib/login-redirect.ts';
import { operatorFeedback } from '../../../../shared/operations/operator/index.ts';
import type { PageLoad } from './$types';

// フィードバックの閲覧の画面。ログインしていなければログインの画面へ（戻り先はこの画面）、同意していなければ同意の画面へ、
// 運用者でなければ組織の選択（/）へ戻す。meta.json が無い（存在しない、または 180 日で消えた）ときは見つからないと出す
export const load: PageLoad = async ({ fetch, url, params }) => {
  const result = await callOperation(operatorFeedback, { id: params.id }, { fetcher: fetch });
  if (isTermsRequired(result)) redirect(307, consentUrl(url));
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  if (!result.ok && result.status === 403) redirect(307, resolve('/'));
  // 長すぎる ID（400）も、存在しない ID と同じ「見つからない」にする
  if (!result.ok && (result.status === 404 || result.status === 400)) return { state: 'not-found' as const };
  if (!result.ok) return { state: 'failed' as const };
  return { state: 'ok' as const, feedback: result.data };
};
