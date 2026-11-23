import {
  myBillingOrganizations,
  billingAdminList,
  billingAdminInvite,
  billingInvitationRespond,
  billingAdminRemove,
  billingOrganizationSummary,
  operatorBillingAdminInvite,
} from '../../shared/operations/billing.ts';
import { now } from '../../shared/clock.ts';
import {
  listBillingOrganizations,
  listBillingAdministrators,
  inviteBillingAdministrator,
  respondBillingInvitation,
  removeBillingAdministrator,
} from '../db/index.ts';
import { implement } from './implement.ts';

export const myBillingOrganizationsOperation = implement(
  myBillingOrganizations,
  async ({ db, accountId, account }) => ({
    account_id: accountId,
    operator: await account.isOperator(),
    ...(await listBillingOrganizations(db, accountId, now())),
  }),
);
export const billingAdminListOperation = implement(billingAdminList, async ({ db, accountId, input }) =>
  listBillingAdministrators(db, input.slug, accountId),
);
export const billingOrganizationSummaryOperation = implement(billingOrganizationSummary, async ({ account, input }) =>
  account.billingOrganization(input.slug, now()),
);
export const billingAdminInviteOperation = implement(billingAdminInvite, async ({ db, accountId, input }) =>
  inviteBillingAdministrator(db, input, accountId, now()),
);
export const billingInvitationRespondOperation = implement(
  billingInvitationRespond,
  async ({ db, accountId, input }) => {
    await respondBillingInvitation(db, input.invitation_id, input.accept, accountId, now());
    return {};
  },
);
export const billingAdminRemoveOperation = implement(billingAdminRemove, async ({ db, accountId, input }) => {
  await removeBillingAdministrator(db, input.slug, input.administrator_id, accountId, now());
  return {};
});
export const operatorBillingAdminInviteOperation = implement(
  operatorBillingAdminInvite,
  async ({ db, accountId, input }) => inviteBillingAdministrator(db, input, accountId, now(), true),
);
export const billingOperations = [
  myBillingOrganizationsOperation,
  billingAdminListOperation,
  billingOrganizationSummaryOperation,
  billingAdminInviteOperation,
  billingInvitationRespondOperation,
  billingAdminRemoveOperation,
  operatorBillingAdminInviteOperation,
];
