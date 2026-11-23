import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { callOperation } from '../../../lib/api.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import {
  myBillingOrganizations,
  billingAdminList,
  billingOrganizationSummary,
} from '../../../shared/operations/billing.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
  const result = await callOperation(myBillingOrganizations, {}, { fetcher: fetch });
  if (isTermsRequired(result)) redirect(307, consentUrl(url));
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  if (!result.ok) return { failed: true as const };
  const slug = url.searchParams.get('organization');
  const organization = result.data.organizations.find((item) => item.slug === slug);
  if (slug !== null && !organization) redirect(307, resolve('/auth/billing'));
  if (organization) {
    // 契約と使用量は担当者の一覧と別の操作で、組織の DB を読む（失敗や負荷を担当者の管理に巻き込まない）。並べて呼ぶ
    const [details, summary] = await Promise.all([
      callOperation(billingAdminList, { slug: organization.slug }, { fetcher: fetch }),
      callOperation(billingOrganizationSummary, { slug: organization.slug }, { fetcher: fetch }),
    ]);
    if (!details.ok) return { failed: true as const };
    // 契約と使用量だけが読めなかったときは、その紙に失敗を出し、担当者の管理は使えるままにする
    return {
      failed: false as const,
      ...result.data,
      selected: {
        ...organization,
        ...details.data,
        summary: summary.ok ? summary.data : null,
        // 回数の上限に当たったときは、待てば読めることを伝える
        summaryRateLimited: !summary.ok && summary.error?.code === 'rate_limited',
      },
    };
  }
  return { failed: false as const, ...result.data, selected: null };
};
