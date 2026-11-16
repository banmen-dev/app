// 一覧を読んだ後の認可の変化と、上限・失敗を組み合わせて確かめる。
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { myToday } from '../src/shared/operations/organization/my-today.ts';
import { createMembership, createOrganization, createTask, createUser, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
const NOW = '2026-11-02T03:00:00.000Z';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

async function targetFor(person: Person, name: string) {
  const organization = await createOrganization({ name });
  const user = await createUser(organization, {
    account_id: person.accountId,
    login_provider: person.login.provider,
    login_subject: person.login.subject,
  });
  const workspace = await createWorkspace(organization, user.id);
  await createMembership(organization, workspace.id, user.id);
  const task = await createTask(organization, workspace.id, user.id, {
    title: `${name}の本人の仕事`,
    assignee_user_id: user.id,
    today_on: '2026-11-02',
  });
  return { organization, user, workspace, task };
}
const ref = (target: Awaited<ReturnType<typeof targetFor>>) => ({
  slug: target.organization.slug,
  name: target.organization.name,
  kind: target.organization.kind,
});
async function read(person: Person, env: Env) {
  const response = await post(app, myToday, { token: person.token, env });
  expect(response.status).toBe(200);
  return myToday.output.parse(await response.json());
}

test.each(['suspended', 'disabled', 'left'] as const)(
  '一覧を読んだ直後に %s になった組織ではタスクを読まず、ほかの組織は残す',
  async (change) => {
    const person = await createPerson();
    const revoked = await targetFor(person, 'あ変わる工房');
    const ordinary = await targetFor(person, 'い継続中の工房');
    let changed = false;
    const env = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (changed || !sql.includes('from "organizations"') || !sql.includes('"id" in')) return;
        changed = true;
        if (change === 'suspended') {
          const db = commonDb(testEnv);
          await db.run(
            db.statement((q) =>
              q.updateTable('organizations').set({ suspended_at: NOW }).where('id', '=', revoked.organization.id),
            ),
          );
        } else {
          const db = orgDb(testEnv, revoked.organization.verified);
          if (change === 'disabled') {
            await db.run(
              db.statement((q) =>
                q
                  .updateTable('users')
                  .set({ disabled_at: NOW })
                  .where('organization_id', '=', db.organizationId)
                  .where('id', '=', revoked.user.id),
              ),
            );
          } else {
            await db.run(
              db.statement((q) =>
                q
                  .updateTable('memberships')
                  .set({ left_at: NOW, left_on: '2026-11-02' })
                  .where('workspace_id', '=', revoked.workspace.id)
                  .where('user_id', '=', revoked.user.id),
              ),
            );
          }
        }
      },
    });
    const view = await read(person, env);
    expect(changed).toBe(true);
    expect(view.tasks.map((task) => task.id)).toEqual([ordinary.task.id]);
    expect(view.failed_organizations).toEqual([ref(revoked)]);
    expect(view.omitted_organizations).toBe(0);
  },
);

test('上限内で1組織が失敗しても11番目に置き換えず、読むタスクのbatchは10回に収める', async () => {
  const person = await createPerson();
  const targets = [];
  for (let index = 0; index < 11; index++)
    targets.push(await targetFor(person, `${String(index).padStart(2, '0')}工房`));
  let taskBatches = 0;
  const env = envWithD1Hooks(testEnv, {
    beforeBatch: (sqls) => {
      if (!sqls.some((sql) => sql.includes('"tasks" as "t"'))) return;
      taskBatches++;
      if (taskBatches === 1) throw new Error('架空の読み取り失敗');
    },
  });
  const view = await read(person, env);
  expect(taskBatches).toBe(10);
  expect(view.tasks).toHaveLength(9);
  expect(view.failed_organizations).toHaveLength(1);
  const shown = [
    ...view.tasks.map((task) => task.organization.slug),
    ...view.failed_organizations.map((organization) => organization.slug),
  ].sort();
  expect(shown).toEqual(
    targets
      .slice(0, 10)
      .map((target) => target.organization.slug)
      .sort(),
  );
  expect(shown).not.toContain(targets[10]!.organization.slug);
  expect(view.omitted_organizations).toBe(1);
});

test('すべての組織の読取失敗でも200で全失敗組織を名前順に返し、空の成功と区別する', async () => {
  const person = await createPerson();
  const second = await targetFor(person, 'い工房');
  const first = await targetFor(person, 'あ工房');
  const env = envWithD1Hooks(testEnv, {
    beforeBatch: (sqls) => {
      if (sqls.some((sql) => sql.includes('"tasks" as "t"'))) throw new Error('架空の読み取り失敗');
    },
  });
  expect(await read(person, env)).toEqual({
    tasks: [],
    failed_organizations: [ref(first), ref(second)],
    omitted_organizations: 0,
  });
});
