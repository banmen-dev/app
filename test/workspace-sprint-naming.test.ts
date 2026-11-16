import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { workspaceSprintNamingUpdateOperation } from '../src/server/operations/workspace.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  workspaceInfo,
  workspaceClose,
  workspaceSprintNamingUpdate,
} from '../src/shared/operations/workspace/index.ts';
import { sprintCreate, sprintDelete, sprintList } from '../src/shared/operations/sprint/index.ts';
import { post, errorCodeOf } from './operations/harness.ts';
import { createTarget, type Target, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);
function update(
  target: Target,
  template: string | null,
  next = 1,
  person: Person = target.leader,
  id = target.workspace.id,
) {
  return post(app, workspaceSprintNamingUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: id, sprint_name_template: template, sprint_number_next: next },
  });
}
async function list(target: Target) {
  const res = await post(app, sprintList, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id },
  });
  expect(res.status).toBe(200);
  return sprintList.output.parse(await res.json());
}
async function logs(target: Target) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['changes_json', 'entity_type', 'action'])
        .where('organization_id', '=', target.organization.id)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
}

// 実際の値を読んだ直後に、別の要求を割り込ませる（workspace-dodの競合テストと同じ入口）。
async function updateWithRace(target: Target, template: string, next: number, race: (n: number) => Promise<void>) {
  const db = orgDb(env, target.organization.verified);
  const actor = {
    accountId: target.leader.accountId,
    userId: target.leader.userId,
    isAdmin: false,
    invitedOnly: false,
  };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let reads = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      const method = Reflect.get(base, key, base);
      if (typeof method !== 'function') return method;
      if (key !== 'first') return method.bind(base);
      return async (...args: unknown[]) => {
        const result = await (method as (...args: unknown[]) => Promise<unknown>).apply(base, args);
        if (typeof result === 'object' && result !== null && 'sprint_name_template' in result) await race(++reads);
        return result;
      };
    },
  });
  return workspaceSprintNamingUpdateOperation.handler({
    db: racing,
    actor,
    workspace,
    input: { workspace_id: target.workspace.id, sprint_name_template: template, sprint_number_next: next },
    defer: () => {},
  } as never);
}

describe('スプリント命名のAPI', () => {
  test('初期値、変更、読み取り、空への変更と同じ値の履歴', async () => {
    const target = await createTarget();
    expect((await list(target)).defaults).toMatchObject({
      sprint_name_template: null,
      sprint_number_next: 1,
    });
    expect((await update(target, '  スプリント{n}  ', 12)).status).toBe(200);
    expect((await list(target)).defaults).toMatchObject({
      sprint_name_template: 'スプリント{n}',
      sprint_number_next: 12,
    });
    const res = await post(app, workspaceInfo, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(await res.json()).toMatchObject({ sprint_name_template: 'スプリント{n}', sprint_number_next: 12 });
    expect(await logs(target)).toEqual([
      expect.objectContaining({
        entity_type: 'workspace',
        action: 'update',
        changes_json: JSON.stringify({ sprint_name_template: [null, 'スプリント{n}'], sprint_number_next: [1, 12] }),
      }),
    ]);
    expect((await update(target, 'スプリント{n}', 12)).status).toBe(200);
    expect(await logs(target)).toHaveLength(1);
    expect((await update(target, ' ', 12)).status).toBe(200);
    expect((await list(target)).defaults.sprint_name_template).toBeNull();
  });

  test('作成だけで番号を進め、重複した作成の拒否と削除では戻さず、保存した名前を変更しない', async () => {
    const target = await createTarget();
    await update(target, 'スプリント{n}', 12);
    const create = (start: string, name: string | null) =>
      post(app, sprintCreate, {
        slug: target.slug,
        token: target.leader.token,
        body: { workspace_id: target.workspace.id, name, start_on: start, length: 7 },
      });
    const first = await create('2027-01-04', '確定した名前');
    expect(first.status).toBe(200);
    const id = sprintCreate.output.parse(await first.json()).sprint.id;
    expect((await list(target)).defaults.sprint_number_next).toBe(13);
    expect((await create('2027-01-04', null)).status).toBe(409);
    expect((await list(target)).defaults.sprint_number_next).toBe(13);
    await update(target, '{yyyy}', 13);
    expect((await list(target)).sprints[0].name).toBe('確定した名前');
    const del = await post(app, sprintDelete, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, sprint_id: id },
    });
    expect(del.status).toBe(200);
    expect((await list(target)).defaults.sprint_number_next).toBe(13);
    expect((await create('2027-01-04', null)).status).toBe(200);
    expect((await list(target)).defaults.sprint_number_next).toBe(14);
    expect((await logs(target)).filter((log) => log.entity_type === 'sprint' && log.action === 'create')).toHaveLength(
      2,
    );
  });

  test('最大安全整数では作成を409で断り、行・番号・履歴を変えず、設定で戻せば再作成できる', async () => {
    const target = await createTarget();
    const max = Number.MAX_SAFE_INTEGER;
    expect((await update(target, '{n}', max)).status).toBe(200);
    const beforeLogs = await logs(target);
    const create = () =>
      post(app, sprintCreate, {
        slug: target.slug,
        token: target.leader.token,
        body: { workspace_id: target.workspace.id, start_on: '2027-01-04', length: 7, name: '上限の確認' },
      });
    const rejected = await create();
    expect(rejected.status).toBe(409);
    expect(await errorCodeOf(rejected)).toBe('conflict');
    expect((await list(target)).defaults.sprint_number_next).toBe(max);
    expect((await list(target)).sprints).toHaveLength(0);
    expect(await logs(target)).toEqual(beforeLogs);
    expect((await update(target, '{n}', max - 1)).status).toBe(200);
    expect((await create()).status).toBe(200);
    expect((await list(target)).defaults.sprint_number_next).toBe(max);
  });

  test('リーダーと管理者は変更でき、メンバーは403、別組織と存在しないIDは404、閉じたら409', async () => {
    const target = await createTarget();
    expect((await update(target, '{n}', 2, target.admin)).status).toBe(200);
    expect((await update(target, '{n}', 3, target.member)).status).toBe(403);
    const other = await createTarget();
    expect((await update(target, '{n}', 4, target.leader, other.workspace.id)).status).toBe(404);
    expect((await update(target, '{n}', 4, target.leader, '019a0000-0000-7000-8000-ffffffffffff')).status).toBe(404);
    const close = await post(app, workspaceClose, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(close.status).toBe(200);
    const res = await update(target, '{n}', 2);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect((await list(target)).defaults.sprint_number_next).toBe(2);
    const before = await logs(target);
    const different = await update(target, '{yyyy}', 5);
    expect(different.status).toBe(409);
    expect(await errorCodeOf(different)).toBe('workspace_closed');
    expect((await list(target)).defaults).toMatchObject({ sprint_name_template: '{n}', sprint_number_next: 2 });
    expect(await logs(target)).toEqual(before);
  });

  test('値を読んだ後に閉じたら、異なる値のUPDATEも拒否し、番号と履歴を変更しない', async () => {
    const target = await createTarget();
    expect((await update(target, '{n}', 2)).status).toBe(200);
    let afterClosing: Awaited<ReturnType<typeof logs>> = [];
    await expect(
      updateWithRace(target, '{yyyy}', 5, async (n) => {
        expect(n).toBe(1);
        const closed = await post(app, workspaceClose, {
          slug: target.slug,
          token: target.admin.token,
          body: { workspace_id: target.workspace.id },
        });
        expect(closed.status).toBe(200);
        afterClosing = await logs(target);
      }),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect((await list(target)).defaults).toMatchObject({ sprint_name_template: '{n}', sprint_number_next: 2 });
    expect(await logs(target)).toEqual(afterClosing);
  });

  test.each([
    ['{unknown}', 1],
    ['x'.repeat(101), 1],
    ['x\u0000{n}', 1],
    ['{n}', 0],
    ['{n}', 1.5],
  ])('無効なルールまたは番号を400で断る', async (template, number) => {
    const target = await createTarget();
    const res = await update(target, template as string, number as number);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await logs(target)).toHaveLength(0);
  });
});
