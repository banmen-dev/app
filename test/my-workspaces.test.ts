// 全組織のダッシュボード（/）の、組織ごとの自分のワークスペース（my-workspaces）。登録済みの操作を Workers と D1 の入口から呼ぶ
import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { createApp } from '../src/server/app.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { myWorkspaces } from '../src/shared/operations/organization/my-workspaces.ts';
import { organizationFor, organizationRef } from './dashboard-accounts.ts';
import { createMembership, createUser, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
type View = z.output<typeof myWorkspaces.output>;

async function read(person: Person, env: Env = testEnv): Promise<View> {
  const response = await post(app, myWorkspaces, { token: person.token, env });
  expect(response.status).toBe(200);
  return myWorkspaces.output.parse(await response.json());
}

describe('my-workspaces: 組織ごとの自分のワークスペース', () => {
  test('組織ごとに、その組織での自分の ID と、所属するワークスペースを名前の順にロールつきで返す', async () => {
    const person = await createPerson();
    const team = await organizationFor(person, { name: '青葉工房', workspaceName: '受付の班' });
    const leading = await createWorkspace(team.organization, team.user.id, { name: '会計の班' });
    await createMembership(team.organization, leading.id, team.user.id, { role: 'leader' });
    const personal = await organizationFor(person, { name: '自分用', personal: true, admin: true });

    const view = await read(person);
    expect(view.omitted_organizations).toBe(0);
    expect(view.failed_organizations).toEqual([]);
    expect(view.organizations).toEqual(
      [
        {
          organization: organizationRef(personal.organization),
          me_id: personal.user.id,
          workspaces: [{ id: personal.workspace.id, name: personal.workspace.name, role: 'member' }],
        },
        {
          organization: organizationRef(team.organization),
          me_id: team.user.id,
          workspaces: [
            { id: leading.id, name: '会計の班', role: 'leader' },
            { id: team.workspace.id, name: '受付の班', role: 'member' },
          ],
        },
      ].sort((a, b) => (a.organization.name < b.organization.name ? -1 : 1)),
    );
  });

  test('管理者でも所属していない班、抜けた班、閉じた班は返さない', async () => {
    const person = await createPerson();
    const target = await organizationFor(person, { admin: true });
    for (const state of ['never', 'left', 'closed'] as const) {
      const workspace = await createWorkspace(target.organization, target.user.id, {
        name: `${state} の班`,
        closed_at: state === 'closed' ? '2026-11-01T00:00:00.000Z' : null,
      });
      if (state !== 'never')
        await createMembership(target.organization, workspace.id, target.user.id, {
          ...(state === 'left' ? { left_on: '2026-11-01', left_at: '2026-11-01T00:00:00.000Z' } : {}),
        });
    }
    const view = await read(person);
    expect(view.organizations.map((entry) => entry.workspaces.map((workspace) => workspace.id))).toEqual([
      [target.workspace.id],
    ]);
  });

  test('停止した組織、無効にされた組織、別のアカウントの組織は返さない。同じ組織のほかの人の所属も返さない', async () => {
    const person = await createPerson();
    const active = await organizationFor(person);
    await organizationFor(person, { suspended: true });
    await organizationFor(person, { disabled: true });
    const other = await createPerson();
    await organizationFor(other);
    const colleague = await createUser(active.organization);
    const colleagueOnly = await createWorkspace(active.organization, colleague.id, { name: '同僚だけの班' });
    await createMembership(active.organization, colleagueOnly.id, colleague.id);

    const view = await read(person);
    expect(view.organizations.map((entry) => entry.organization)).toEqual([organizationRef(active.organization)]);
    expect(view.organizations[0]!.workspaces.map((workspace) => workspace.id)).toEqual([active.workspace.id]);
  });

  test('所属が無い管理者の組織は、空の一覧で返す', async () => {
    const person = await createPerson();
    const target = await organizationFor(person, { admin: true, join: false });
    const view = await read(person);
    expect(view.organizations).toEqual([
      { organization: organizationRef(target.organization), me_id: target.user.id, workspaces: [] },
    ]);
  });

  test('1組織の読み取りに失敗しても、ほかの組織の分と、読めなかった組織を返す', async () => {
    const person = await createPerson();
    const first = await organizationFor(person, { name: 'あ工房' });
    const second = await organizationFor(person, { name: 'い工房' });
    let failures = 0;
    const env = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (failures === 0 && sql.includes('"w"."closed_at" is null') && sql.includes('order by "w"."name"')) {
          failures++;
          throw new Error('架空の読み取りエラー');
        }
      },
    });
    const view = await read(person, env);
    expect(failures).toBe(1);
    expect(view.failed_organizations).toHaveLength(1);
    const failed = [first, second].find((target) => target.organization.slug === view.failed_organizations[0]!.slug)!;
    const successful = failed === first ? second : first;
    expect(view.organizations.map((entry) => entry.organization)).toEqual([organizationRef(successful.organization)]);
  });

  test('入れる組織が無い人は、空で成功する', async () => {
    const person = await createPerson();
    expect(await read(person)).toEqual({ organizations: [], omitted_organizations: 0, failed_organizations: [] });
  });
});
