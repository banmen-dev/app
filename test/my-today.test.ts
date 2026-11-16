// 組織の外から読む本人の今日やること。登録済みの操作を Workers と D1 の入口から呼ぶ。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { z } from 'zod';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { readAccountTaskOrganizations } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { myToday } from '../src/shared/operations/organization/my-today.ts';
import { today } from '../src/shared/operations/organization/today.ts';
import {
  createBoardColumn,
  createDelegatee,
  createInvitation,
  createMembership,
  createOrganization,
  createPersonalOrganizationRow,
  createSprint,
  createTask,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
const NOW = new Date('2026-11-02T03:00:00.000Z');
type MyTodayView = z.output<typeof myToday.output>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function organizationFor(
  person: Person,
  options: {
    name?: string;
    slug?: string;
    suspended?: boolean;
    disabled?: boolean;
    admin?: boolean;
    join?: boolean;
    closed?: boolean;
    personal?: boolean;
  } = {},
) {
  const overrides = {
    name: options.name ?? '青葉工房',
    ...(options.slug === undefined ? {} : { slug: options.slug }),
    suspended_at: options.suspended ? '2026-11-01T00:00:00.000Z' : null,
  };
  const organization = options.personal
    ? await createPersonalOrganizationRow(person.accountId, overrides)
    : await createOrganization(overrides);
  const user = await createUser(organization, {
    account_id: person.accountId,
    login_provider: person.login.provider,
    login_subject: person.login.subject,
    is_admin: options.admin ? 1 : 0,
    disabled_at: options.disabled ? '2026-11-01T00:00:00.000Z' : null,
  });
  const workspace = await createWorkspace(organization, user.id, {
    name: `${organization.name}の班`,
    closed_at: options.closed ? '2026-11-01T00:00:00.000Z' : null,
  });
  if (options.join !== false) await createMembership(organization, workspace.id, user.id);
  const task = await createTask(organization, workspace.id, user.id, {
    title: `${organization.name}の仕事`,
    assignee_user_id: user.id,
    today_on: '2026-11-02',
  });
  return { organization, user, workspace, task };
}

async function read(person: Person, env: Env = testEnv): Promise<MyTodayView> {
  const response = await post(app, myToday, { token: person.token, env });
  expect(response.status).toBe(200);
  return myToday.output.parse(await response.json());
}

function organizationRef(organization: OrganizationFixture) {
  return { slug: organization.slug, name: organization.name, kind: organization.kind };
}

describe('my-today: 全組織の本人の今日やること', () => {
  test('組織をまたぐ関数は、認可済みの本人と入口で読み、入口を外へ返さない', async () => {
    const person = await createPerson();
    const target = await organizationFor(person);
    await organizationFor(person, { suspended: true });
    const seen: { organizationId: string; userId: string }[] = [];
    const listed = await readAccountTaskOrganizations(
      testEnv,
      {
        accountId: person.accountId,
        logins: [person.login],
        authenticatedAt: NOW.toISOString(),
      },
      async (db, userId) => {
        seen.push({ organizationId: db.organizationId, userId });
        return { value: '読めた' };
      },
    );
    expect(listed.omitted_organizations).toBe(0);
    expect(listed.organizations).toHaveLength(1);
    expect(listed.organizations[0]!.organization).toEqual(organizationRef(target.organization));
    expect(seen).toEqual([{ organizationId: target.organization.id, userId: target.user.id }]);
    expect(listed.organizations[0]!.data).toEqual({ value: '読めた' });
    expect(listed.organizations[0]).not.toHaveProperty('db');
    expect(listed.organizations[0]).not.toHaveProperty('userId');
    expect(listed.failed_organizations).toEqual([]);
  });

  test('2組織の別々の本人 userId を使い、組織名・種類・ワークスペース名を付ける', async () => {
    const person = await createPerson();
    const team = await organizationFor(person, { name: '青葉工房' });
    const personal = await organizationFor(person, { name: '個人の工房', personal: true, admin: true });
    const view = await read(person);
    expect(view.tasks).toHaveLength(2);
    for (const target of [team, personal]) {
      expect(view.tasks.find((task) => task.id === target.task.id)).toMatchObject({
        organization: organizationRef(target.organization),
        workspace_id: target.workspace.id,
        workspace_name: target.workspace.name,
        assignee: { id: target.user.id },
      });
    }
    expect(view.omitted_organizations).toBe(0);
    expect(view.failed_organizations).toEqual([]);
    expect(view).not.toHaveProperty('sprint_goals');
  });

  test('組織の today と同じ6区分に必要な値・時差・持ち越し・完了を返す', async () => {
    const person = await createPerson();
    const target = await organizationFor(person, { name: '青葉工房' });
    const { organization, workspace, user } = target;
    const delegatee = await createDelegatee(organization);
    const sprint = await createSprint(organization, workspace.id, { status: 'active', goal: '今週の目標' });
    const column = await createBoardColumn(organization, workspace.id);
    const variants: Parameters<typeof createTask>[3][] = [
      { title: '期日切れ', due_on: '2026-11-01' },
      { title: '持ち越し', today_on: '2026-10-31' },
      { title: '依頼中', delegatee_id: delegatee.id },
      { title: '今週の期日', due_on: '2026-11-05' },
      { title: 'スプリント', sprint_id: sprint.id, column_id: column.id, column_position: 'a0' },
      { title: '今日完了', completed_at: '2026-11-02T00:00:00.000Z', completed_by: user.id },
    ];
    for (const variant of variants) {
      await createTask(organization, workspace.id, user.id, { assignee_user_id: user.id, ...variant });
    }
    const la = await createWorkspace(organization, user.id, { name: '西の班', timezone: 'America/Los_Angeles' });
    await createMembership(organization, la.id, user.id);
    await createTask(organization, la.id, user.id, {
      title: '西では今日の完了',
      assignee_user_id: user.id,
      completed_at: '2026-11-01T20:00:00.000Z',
      completed_by: user.id,
    });
    const organizationResponse = await post(app, today, { token: person.token, slug: organization.slug });
    expect(organizationResponse.status).toBe(200);
    const expected = today.output.parse(await organizationResponse.json());
    expect(expected.tasks).toHaveLength(8);
    const view = await read(person);
    const withoutOrganization = view.tasks.map(({ organization: _organization, ...task }) => {
      void _organization;
      return task;
    });
    const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(withoutOrganization)).toEqual(byId(expected.tasks));
  });

  test('停止・本人無効・所属なしの組織と別アカウントの仕事を含めない', async () => {
    const person = await createPerson();
    const active = await organizationFor(person);
    await organizationFor(person, { suspended: true });
    await organizationFor(person, { disabled: true });
    await organizationFor(person, { join: false });
    const other = await createPerson();
    await organizationFor(other);
    const colleague = await createUser(active.organization);
    await createMembership(active.organization, active.workspace.id, colleague.id);
    await createTask(active.organization, active.workspace.id, colleague.id, {
      title: '同僚の仕事',
      assignee_user_id: colleague.id,
      today_on: '2026-11-02',
    });
    expect((await read(person)).tasks.map((task) => task.id)).toEqual([active.task.id]);
  });

  test('管理者でも所属していない班・抜けた班・閉じた班のタスクを読まない', async () => {
    const person = await createPerson();
    const target = await organizationFor(person, { admin: true });
    for (const state of ['never', 'left', 'closed'] as const) {
      const workspace = await createWorkspace(target.organization, target.user.id, {
        closed_at: state === 'closed' ? '2026-11-01T00:00:00.000Z' : null,
      });
      if (state !== 'never')
        await createMembership(target.organization, workspace.id, target.user.id, {
          ...(state === 'left' ? { left_on: '2026-11-01', left_at: '2026-11-01T00:00:00.000Z' } : {}),
        });
      await createTask(target.organization, workspace.id, target.user.id, {
        title: `${state} の仕事`,
        assignee_user_id: target.user.id,
        today_on: '2026-11-02',
      });
    }
    expect((await read(person)).tasks.map((task) => task.id)).toEqual([target.task.id]);
  });

  test('招待だけの組織やアカウントにまだ結ばれていない本人の行を読まない', async () => {
    const person = await createPerson();
    const elsewhere = await createPerson();
    const target = await organizationFor(elsewhere);
    await createInvitation(target.organization, target.workspace.id, target.user.id, person.login);
    const unlinked = await createUser(target.organization, {
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    await createMembership(target.organization, target.workspace.id, unlinked.id);
    await createTask(target.organization, target.workspace.id, unlinked.id, {
      assignee_user_id: unlinked.id,
      today_on: '2026-11-02',
    });
    expect(await read(person)).toEqual({ tasks: [], omitted_organizations: 0, failed_organizations: [] });
  });

  test('名前順（同名は slug 順）の先頭10組織だけを読み、超過数を返す', async () => {
    const person = await createPerson();
    const targets = [];
    for (let index = 11; index >= 0; index--) {
      targets.push(
        await organizationFor(person, {
          name: index < 2 ? '00 同じ工房' : `${String(index).padStart(2, '0')} 工房`,
        }),
      );
    }
    targets.sort((a, b) => {
      const x = a.organization,
        y = b.organization;
      return x.name === y.name ? (x.slug < y.slug ? -1 : 1) : x.name < y.name ? -1 : 1;
    });
    const view = await read(person);
    expect(view.tasks.map((task) => task.organization.slug).sort()).toEqual(
      targets
        .slice(0, 10)
        .map((target) => target.organization.slug)
        .sort(),
    );
    expect(view.omitted_organizations).toBe(2);
    expect(view.failed_organizations).toEqual([]);
  });

  test('1組織の今日の読み取りに失敗しても、ほかの組織の仕事と失敗組織名を返す', async () => {
    const person = await createPerson();
    const first = await organizationFor(person, { name: 'あ工房' });
    const second = await organizationFor(person, { name: 'い工房' });
    let failures = 0;
    const env = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (failures === 0 && sqls.some((sql) => sql.includes('"tasks" as "t"'))) {
          failures++;
          throw new Error('架空の組織データ読み取りエラー');
        }
      },
    });
    const view = await read(person, env);
    expect(failures).toBe(1);
    expect(view.failed_organizations).toHaveLength(1);
    const failedSlug = view.failed_organizations[0]!.slug;
    const failed = [first, second].find((target) => target.organization.slug === failedSlug)!;
    const successful = failed === first ? second : first;
    expect(view.failed_organizations).toEqual([organizationRef(failed.organization)]);
    expect(view.tasks.map((task) => task.id)).toEqual([successful.task.id]);
    expect(view.omitted_organizations).toBe(0);
  });

  test('今日の対象がない所属済み会員と、組織がない会員のどちらも空で成功する', async () => {
    const person = await createPerson();
    expect(await read(person)).toEqual({ tasks: [], omitted_organizations: 0, failed_organizations: [] });
    const organization = await createOrganization();
    const user = await createUser(organization, {
      account_id: person.accountId,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    const workspace = await createWorkspace(organization, user.id);
    await createMembership(organization, workspace.id, user.id);
    await createTask(organization, workspace.id, user.id, { assignee_user_id: user.id });
    expect(await read(person)).toEqual({ tasks: [], omitted_organizations: 0, failed_organizations: [] });
  });
});
