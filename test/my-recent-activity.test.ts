// 全組織のダッシュボード（/）の「最近の更新」（my-recent-activity）。登録済みの操作を Workers と D1 の入口から呼ぶ。
// 1つの組織の中の決まり（出す履歴、出さない履歴、本文の切り方）は test/recent-activity.test.ts が確かめる。
// ここでは、組織をまたいで混ぜた並び、組織の名前、カーソル、ワークスペースの上限、読む範囲、1組織の失敗を確かめる
import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { createApp } from '../src/server/app.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { myRecentActivity } from '../src/shared/operations/organization/my-recent-activity.ts';
import {
  RECENT_ACTIVITY_PAGE_SIZE,
  RECENT_ACTIVITY_WORKSPACE_LIMIT,
} from '../src/shared/operations/organization/recent-activity.ts';
import { organizationFor, organizationRef } from './dashboard-accounts.ts';
import {
  createChangeLog,
  createComment,
  createMembership,
  createTask,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
type View = z.output<typeof myRecentActivity.output>;
type Cursor = NonNullable<View['next']>;

async function read(person: Person, before?: Cursor, env: Env = testEnv): Promise<View> {
  const response = await post(app, myRecentActivity, {
    token: person.token,
    env,
    body: before === undefined ? {} : { before },
  });
  expect(response.status).toBe(200);
  return myRecentActivity.output.parse(await response.json());
}

// 2030-01-01T00:00:00.000Z から minutes 分後
function minutesLater(minutes: number): string {
  return new Date(Date.UTC(2030, 0, 1) + minutes * 60_000).toISOString();
}

// ワークスペースにタスクを1つ作り、題を変えた変更の行を at に足す
async function taskChange(
  organization: OrganizationFixture,
  workspaceId: string,
  userId: string,
  at: string,
  title = '見積もりを送る',
) {
  const task = await createTask(organization, workspaceId, userId, { title });
  const log = await createChangeLog(organization, {
    workspace_id: workspaceId,
    actor_user_id: userId,
    entity_type: 'task',
    entity_id: task.id,
    action: 'update',
    changes_json: JSON.stringify({ title: ['前', title] }),
    created_at: at,
  });
  return { task, log };
}

describe('my-recent-activity: 全組織の最近の更新', () => {
  test('組織をまたいで新しい順に混ぜ、各行に組織と、その組織でのした人の名前を添える', async () => {
    const person = await createPerson();
    const team = await organizationFor(person, { name: '青葉工房' });
    const personal = await organizationFor(person, { name: '自分用', personal: true, admin: true });
    const first = await taskChange(team.organization, team.workspace.id, team.user.id, minutesLater(1), '受付表を直す');
    await createComment(
      personal.organization,
      personal.workspace.id,
      (await taskChange(personal.organization, personal.workspace.id, personal.user.id, minutesLater(2), '本を読む'))
        .task.id,
      personal.user.id,
      {
        body_md: '半分まで読んだ。',
        created_at: minutesLater(3),
      },
    );

    const view = await read(person);
    expect(view.next).toBeNull();
    expect(view.omitted_organizations).toBe(0);
    expect(view.failed_organizations).toEqual([]);
    expect(
      view.entries.map((entry) => [entry.created_at, entry.organization.slug, entry.target.title, entry.event.kind]),
    ).toEqual([
      [minutesLater(3), personal.organization.slug, '本を読む', 'comment'],
      [minutesLater(2), personal.organization.slug, '本を読む', 'update'],
      [minutesLater(1), team.organization.slug, '受付表を直す', 'update'],
    ]);
    expect(view.entries[2]).toMatchObject({
      id: first.log.id,
      organization: organizationRef(team.organization),
      workspace: { id: team.workspace.id, name: team.workspace.name },
      actor: { id: team.user.id, name: team.user.name },
    });
    expect(view.entries[0]!.organization).toEqual(organizationRef(personal.organization));
  });

  test('同じ時刻の行が組織をまたいでも、さらに読むで重なりも抜けも無い', async () => {
    const person = await createPerson();
    const a = await organizationFor(person, { name: 'あ工房' });
    const b = await organizationFor(person, { name: 'い工房' });
    const ids: string[] = [];
    for (let index = 0; index < 15; index++) {
      const at = minutesLater(Math.floor(index / 3));
      ids.push((await taskChange(a.organization, a.workspace.id, a.user.id, at)).log.id);
      ids.push((await taskChange(b.organization, b.workspace.id, b.user.id, at)).log.id);
    }

    const seen: string[] = [];
    let before: Cursor | undefined;
    let pages = 0;
    do {
      const view = await read(person, before);
      seen.push(...view.entries.map((entry) => entry.id));
      expect(view.entries.length).toBeLessThanOrEqual(RECENT_ACTIVITY_PAGE_SIZE);
      before = view.next ?? undefined;
      pages++;
    } while (before !== undefined && pages < 5);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  test('所属していない班、閉じた班、停止した組織、無効にされた組織、別のアカウントの組織の分は出ない', async () => {
    const person = await createPerson();
    const active = await organizationFor(person, { admin: true });
    const shown = await taskChange(active.organization, active.workspace.id, active.user.id, minutesLater(1));
    const colleague = await createUser(active.organization);
    const notMine = await createWorkspace(active.organization, colleague.id);
    await createMembership(active.organization, notMine.id, colleague.id);
    await taskChange(active.organization, notMine.id, colleague.id, minutesLater(2));
    const closed = await createWorkspace(active.organization, active.user.id, {
      closed_at: '2026-11-01T00:00:00.000Z',
    });
    await createMembership(active.organization, closed.id, active.user.id);
    await taskChange(active.organization, closed.id, active.user.id, minutesLater(3));
    for (const options of [{ suspended: true }, { disabled: true }]) {
      const hidden = await organizationFor(person, options);
      await taskChange(hidden.organization, hidden.workspace.id, hidden.user.id, minutesLater(4));
    }
    const other = await organizationFor(await createPerson());
    await taskChange(other.organization, other.workspace.id, other.user.id, minutesLater(5));

    const view = await read(person);
    expect(view.entries.map((entry) => entry.id)).toEqual([shown.log.id]);
  });

  test('ワークスペースの上限は全組織の合計に当て、組織の名前の順、組織の中は新しく作った順に数える', async () => {
    const person = await createPerson();
    const a = await organizationFor(person, { name: 'あ工房' });
    const b = await organizationFor(person, { name: 'い工房' });
    // あ工房に 30、い工房に 30（作った順）。読むのは、あ工房の 30 と、い工房の新しい 20
    const workspacesOf = async (target: typeof a) => {
      const list = [target.workspace.id];
      for (let index = 1; index < 30; index++) {
        const workspace = await createWorkspace(target.organization, target.user.id);
        await createMembership(target.organization, workspace.id, target.user.id);
        list.push(workspace.id);
      }
      return list;
    };
    const aWorkspaces = await workspacesOf(a);
    const bWorkspaces = await workspacesOf(b);
    expect(aWorkspaces.length + bWorkspaces.length - RECENT_ACTIVITY_WORKSPACE_LIMIT).toBe(10);
    // 上限の外になる、い工房の古い 10 個のうち最も新しい班と、上限の中の、い工房の最も古い班に、新しい変更を置く
    const outside = await taskChange(b.organization, bWorkspaces[9]!, b.user.id, minutesLater(10));
    const inside = await taskChange(b.organization, bWorkspaces[10]!, b.user.id, minutesLater(9));
    const oldestOfA = await taskChange(a.organization, aWorkspaces[0]!, a.user.id, minutesLater(8));

    const view = await read(person);
    expect(view.entries.map((entry) => entry.id)).toEqual([inside.log.id, oldestOfA.log.id]);
    expect(view.entries.map((entry) => entry.id)).not.toContain(outside.log.id);
  });

  test('1組織の変更とコメントの読み取りに失敗しても、ほかの組織の分と、読めなかった組織を返す', async () => {
    const person = await createPerson();
    const first = await organizationFor(person, { name: 'あ工房' });
    const second = await organizationFor(person, { name: 'い工房' });
    const firstLog = await taskChange(first.organization, first.workspace.id, first.user.id, minutesLater(1));
    const secondLog = await taskChange(second.organization, second.workspace.id, second.user.id, minutesLater(2));
    let failures = 0;
    const env = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (failures === 0 && sqls.some((sql) => sql.includes('from "change_logs" as "cl"'))) {
          failures++;
          throw new Error('架空の読み取りエラー');
        }
      },
    });
    const view = await read(person, undefined, env);
    expect(failures).toBe(1);
    expect(view.failed_organizations).toHaveLength(1);
    const failedSlug = view.failed_organizations[0]!.slug;
    const expected = failedSlug === first.organization.slug ? secondLog : firstLog;
    expect(view.entries.map((entry) => entry.id)).toEqual([expected.log.id]);
  });

  test('更新が無い人と、入れる組織が無い人は、空で成功する', async () => {
    const person = await createPerson();
    const empty = { entries: [], next: null, omitted_organizations: 0, failed_organizations: [] };
    expect(await read(person)).toEqual(empty);
    await organizationFor(person);
    expect(await read(person)).toEqual(empty);
  });
});
