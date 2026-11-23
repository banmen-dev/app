// 組織の外の操作の処理に渡す、ログインした人についての読み取り。env を処理に渡さず、決まった問い合わせだけを渡す。
// アカウントに結んだログインの手段と ID、入れる組織と届いた招待と停止した組織は、使われたときに1回だけ引く
// （組織の一覧は my-organizations が使い、今日の組織ごとの認可と読み取りは db/ の関数へ任せる）
import type { z } from 'zod';
import type { billingOrganizationSummary } from '../../shared/operations/billing.ts';
import type { myRecentActivity } from '../../shared/operations/organization/my-recent-activity.ts';
import type { myToday } from '../../shared/operations/organization/my-today.ts';
import type { myWorkspaces } from '../../shared/operations/organization/my-workspaces.ts';
import { accountLogins } from '../auth/account-logins.ts';
import { isOperatorLogin, operatorLoginIdOf } from '../auth/operators.ts';
import {
  deleteSelfCreatedOrganization,
  insertPersonalOrganization,
  insertSelfCreatedOrganization,
  listAccountOrganizations,
  readAccountTaskOrganizations,
  readBillingOrganizationSummary,
  type AccountOrganizations,
  type CreatedOrganization,
  type LoginId,
  type OrganizationDb,
} from '../db/index.ts';
import { readAccountRecentActivity } from './my-recent-activity.ts';
import { readAccountWorkspaces } from './my-workspaces.ts';
import { readToday } from './today.ts';

// 入れる組織ごとに、認可した入口と本人のユーザーの ID で読む関数（readAccountTaskOrganizations に env とアカウントを結んだもの）。
// 全組織のダッシュボードの読み取り（今日やること、ワークスペース、最近の更新）が使う
export type AccountOrganizationReader = <T>(
  read: (db: OrganizationDb, userId: string) => Promise<T>,
) => ReturnType<typeof readAccountTaskOrganizations<T>>;

export type OutsideAccount = {
  // このアカウントが自分の組織を作る最初の書き込み（共通の DB の organizations）。slug が重なれば 'slug_taken'、
  // お試し中の組織をすでに持つなら 'trial_limit'。作った人の users と change_logs は、返る組織の入口に呼び出し側が書く
  createOrganization(input: {
    slug: string;
    name: string;
    now: Date;
  }): Promise<CreatedOrganization | 'slug_taken' | 'trial_limit'>;
  // このアカウントが自分用の組織を作る最初の書き込み。slug が重なれば 'slug_taken'、自分用をすでに持つなら 'personal_limit'。
  // お試しの上限（createOrganization の 'trial_limit'）とは数えが別。作った人の users と change_logs は、返る組織の入口に呼び出し側が書く
  createPersonalOrganization(input: {
    slug: string;
    name: string;
    now: Date;
  }): Promise<CreatedOrganization | 'slug_taken' | 'personal_limit'>;
  // createOrganization か createPersonalOrganization で挿入した組織の行を消す補償（最初の管理者を書けなかったとき）。組織の中の表の行があれば外部キーが断り、投げる
  abandonOrganization(organizationId: string): Promise<void>;
  // 入れる組織と、承諾待ちの招待だけがある組織（組織をまたいで読む関数を通す）。アカウントに結ばれる前の行は数えない
  organizations(): Promise<AccountOrganizations>;
  today(): Promise<z.output<typeof myToday.output>>;
  // 入れる組織ごとの、自分が今所属する閉じていないワークスペース
  workspaces(): Promise<z.output<typeof myWorkspaces.output>>;
  // 入れる組織の最近の更新を混ぜた1ページ。before は前のページの最後の行
  recentActivity(
    before: { created_at: string; id: string } | undefined,
  ): Promise<z.output<typeof myRecentActivity.output>>;
  // シークレットの運用者の一覧に、このアカウントのログインが載っているか
  isOperator(): Promise<boolean>;
  // 運用者の一覧に載っているログインの ID（`github:12345` の形）。運用者でなければ undefined
  operatorLoginId(): Promise<string | undefined>;
  // アカウントに結んだログインの手段と ID。登録の関数が、組織に入れるかの判定（enterOrganization）に渡す。引くのは1回だけ
  logins(): Promise<readonly LoginId[]>;
  // 承諾済みの担当組織の契約・上限・利用の状態と、人数と容量の使用量。担当外は存在しない組織と同じ 404
  billingOrganization(slug: string, at: Date): Promise<z.input<typeof billingOrganizationSummary.output>>;
};

export function outsideAccount(env: Env, accountId: string, authenticatedAt: string): OutsideAccount {
  let logins: Promise<LoginId[]> | undefined;
  const loadLogins = () => (logins ??= accountLogins(env, accountId));
  let organizations: Promise<AccountOrganizations> | undefined;
  const readOrganizations: AccountOrganizationReader = async (read) =>
    readAccountTaskOrganizations(env, { accountId, logins: await loadLogins(), authenticatedAt }, read);
  return {
    createOrganization: (input) => insertSelfCreatedOrganization(env, { ...input, accountId }),
    createPersonalOrganization: (input) => insertPersonalOrganization(env, { ...input, accountId }),
    abandonOrganization: (organizationId) => deleteSelfCreatedOrganization(env, { organizationId, accountId }),
    logins: loadLogins,
    today: async () => {
      const result = await readOrganizations((db, userId) => readToday(db, userId, { includeSprintGoals: false }));
      return {
        tasks: result.organizations.flatMap(({ organization, data }) =>
          data.tasks.map((task) => ({ ...task, organization })),
        ),
        failed_organizations: result.failed_organizations,
        omitted_organizations: result.omitted_organizations,
      };
    },
    workspaces: () => readAccountWorkspaces(readOrganizations),
    recentActivity: (before) => readAccountRecentActivity(readOrganizations, before),
    organizations: () =>
      (organizations ??= (async () => listAccountOrganizations(env, { accountId, logins: await loadLogins() }))()),
    isOperator: async () => isOperatorLogin(env, await loadLogins()),
    operatorLoginId: async () => operatorLoginIdOf(env, await loadLogins()),
    billingOrganization: (slug, at) => readBillingOrganizationSummary(env, slug, accountId, at),
  };
}
