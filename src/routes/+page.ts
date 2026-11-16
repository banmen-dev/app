import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { callOperation } from '../lib/api.ts';
import { landingFor } from '../lib/landing.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../lib/login-redirect.ts';
import { myOrganizations } from '../shared/operations/organization/index.ts';
import type { PageLoad } from './$types';

// 会員にはダッシュボードを出す。入れる組織も招待も無い運用者だけ運用の画面へ。
export const load: PageLoad = async ({ fetch, url }) => {
  const result = await callOperation(myOrganizations, {}, { fetcher: fetch });
  if (isTermsRequired(result)) redirect(307, consentUrl(url));
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  if (!result.ok) return { failed: true as const };

  const landing = landingFor(result.data);
  if (landing.to === 'operator') redirect(307, resolve('/operator'));
  // suspended は、応答が持たないとき（古い応答、差し替えた応答）は無いものとする
  return {
    failed: false as const,
    ...result.data,
    suspended: result.data.suspended ?? [],
  };
};
