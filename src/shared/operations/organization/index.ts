import { delegateeCreate, delegateeDelete, delegateeList, delegateeUpdate } from './delegatee.ts';
// 組織の選択と組織の枠、組織の管理の画面が使う操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import {
  createMyOrganization,
  createMyOrganizationConflictReasonOf,
  createMyOrganizationConflictReasons,
  type CreateMyOrganizationConflictReason,
} from './create-my-organization.ts';
import {
  createPersonalOrganization,
  createPersonalOrganizationConflictReasonOf,
  createPersonalOrganizationConflictReasons,
  type CreatePersonalOrganizationConflictReason,
} from './create-personal-organization.ts';
import { firstSteps } from './first-steps.ts';
import { meAvatarDelete, meAvatarUpload, userAvatar } from './me-avatar.ts';
import { meThemeUpdate } from './me-theme-update.ts';
import { myOrganizations } from './my-organizations.ts';
import { myRecentActivity } from './my-recent-activity.ts';
import { myToday } from './my-today.ts';
import { myWorkspaces } from './my-workspaces.ts';
import { organizationInfo } from './organization.ts';
import { organizationHistory } from './organization-history.ts';
import { organizationHolidayAdd, organizationHolidayDelete, organizationHolidayList } from './organization-holiday.ts';
import { userAdminUpdate, userDisable, userEnable, userList } from './user.ts';
import { recentActivity } from './recent-activity.ts';
import { today } from './today.ts';

export {
  delegateeCreate,
  delegateeDelete,
  delegateeList,
  delegateeUpdate,
  createMyOrganization,
  createMyOrganizationConflictReasonOf,
  createMyOrganizationConflictReasons,
  type CreateMyOrganizationConflictReason,
  createPersonalOrganization,
  createPersonalOrganizationConflictReasonOf,
  createPersonalOrganizationConflictReasons,
  type CreatePersonalOrganizationConflictReason,
  firstSteps,
  meAvatarDelete,
  meAvatarUpload,
  meThemeUpdate,
  myOrganizations,
  myRecentActivity,
  myToday,
  myWorkspaces,
  organizationHistory,
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationHolidayList,
  organizationInfo,
  userAdminUpdate,
  userDisable,
  userEnable,
  userAvatar,
  userList,
  today,
  recentActivity,
};

export const organizationOperations: readonly AnyOperationDefinition[] = [
  delegateeCreate,
  delegateeDelete,
  delegateeList,
  delegateeUpdate,
  myOrganizations,
  myToday,
  myWorkspaces,
  myRecentActivity,
  createMyOrganization,
  createPersonalOrganization,
  organizationInfo,
  meThemeUpdate,
  meAvatarUpload,
  meAvatarDelete,
  userAvatar,
  organizationHolidayList,
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationHistory,
  userList,
  userAdminUpdate,
  userDisable,
  userEnable,
  today,
  recentActivity,
  firstSteps,
];
