import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { callOperation } from '../../../lib/api.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { myBillingOrganizations, billingAdminList } from '../../../shared/operations/billing.ts';
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
    const details = await callOperation(billingAdminList, { slug: organization.slug }, { fetcher: fetch });
    if (!details.ok) return { failed: true as const };
    return { failed: false as const, ...result.data, selected: { ...organization, ...details.data } };
  }
  return { failed: false as const, ...result.data, selected: null };
};
