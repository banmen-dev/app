// 本物の同期の保存・再開と、偽 GitHub の取得をつなぐ #1312 の受け入れテスト。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../../src/server/db/index.ts';
import { encryptCredential } from '../../src/server/crypto/credential.ts';
import { syncConnection } from '../../src/server/import/sync.ts';
import { discoveryOnly } from './discovery-only.ts';
import {
  createConnection,
  createConnectionScope,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  uuidv7,
} from '../factories.ts';
import { fakeIssue } from './fake-github-pat.ts';
import { fakePull, ownPullFixture, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

async function setup() {
  const organization = await createOrganization();
  const owner = await createUser(organization);
  const workspace = await createWorkspace(organization, owner.id);
  await createMembership(organization, workspace.id, owner.id);
  const db = orgDb(env, organization.verified);
  async function addConnection() {
    const id = uuidv7();
    const sealed = await encryptCredential(env, PULL_PAT, id);
    const connection = await createConnection(organization, workspace.id, owner.id, {
      id,
      credential_ciphertext: sealed.ciphertext,
      credential_key_version: sealed.keyVersion,
      credential_last4: PULL_PAT.slice(-4),
    });
    await createConnectionScope(organization, id, { source_id: PULL_SCOPE.id, source_name: PULL_SCOPE.name });
    return connection;
  }
  async function sources() {
    return db.rows(
      db.statement((q) => q.selectFrom('task_sources').selectAll().where('workspace_id', '=', workspace.id)),
    );
  }
  async function tasks() {
    return db.rows(db.statement((q) => q.selectFrom('tasks').selectAll().where('workspace_id', '=', workspace.id)));
  }
  return { db, owner, workspace, addConnection, sources, tasks };
}

describe('完了条件: PR を受信箱へ同期する', () => {
  test('再同期と重なる接続で二重作成せず、Issue と PR は別種として保存する', async () => {
    const t = await setup();
    const a = await t.addConnection();
    const b = await t.addConnection();
    const f = ownPullFixture();
    // 同じ数値IDであっても、Issue と PR の種別は分離される。
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 1, { id: 800001 })];
    f.data.pulls = [fakePull(1), fakePull(2, { state: 'closed' }), fakePull(3, { user: { login: 'fake-other' } })];
    const options = { fetcher: f.fetcher };
    expect(await syncConnection(env, t.db, t.workspace.id, a.id, options)).toEqual({
      outcome: 'success',
      imported: 2,
      more: false,
    });
    expect(await syncConnection(env, t.db, t.workspace.id, a.id, options)).toEqual({
      outcome: 'success',
      imported: 0,
      more: false,
    });
    expect(await syncConnection(env, t.db, t.workspace.id, b.id, options)).toEqual({
      outcome: 'success',
      imported: 0,
      more: false,
    });
    const sources = await t.sources();
    expect(sources.map((s) => `${s.source_kind}:${s.source_id}`).sort()).toEqual([
      'issue:800001',
      'pull_request:800001',
    ]);
    const tasks = await t.tasks();
    expect(tasks).toHaveLength(2);
    for (const task of tasks)
      expect(task).toMatchObject({ tray: 'inbox', assignee_user_id: t.owner.id, is_imported: 1 });
  });

  test('GitHub で閉じると完了の印が付き、開き直すと外れる。タスクは完了にならない（Issue と PR）', async () => {
    const t = await setup();
    const c = await t.addConnection();
    const f = ownPullFixture();
    const options = { fetcher: f.fetcher };
    const sync = () => syncConnection(env, t.db, t.workspace.id, c.id, options);
    const marks = async () =>
      Object.fromEntries((await t.sources()).map((s) => [s.source_kind, [s.source_status, s.is_source_done]]));
    // 差分の起点（前回の成功の少し前）より新しい更新日時にする
    const at = (step: number) => new Date(Date.now() + step * 1000).toISOString();
    const state = (day: number, closed: boolean) => {
      f.data.issues = [
        fakeIssue(PULL_SCOPE.name, 1, { id: 800001, state: closed ? 'closed' : 'open', updatedAt: at(day) }),
      ];
      f.data.pulls = [
        fakePull(1, {
          state: closed ? 'closed' : 'open',
          merged_at: closed ? at(day) : null,
          updated_at: at(day),
        }),
      ];
    };
    state(1, false);
    expect(await sync()).toMatchObject({ outcome: 'success', imported: 2 });
    expect(await marks()).toEqual({ issue: ['open', 0], pull_request: ['open', 0] });

    state(2, true);
    expect(await sync()).toMatchObject({ outcome: 'success', imported: 0 });
    expect(await marks()).toEqual({ issue: ['closed', 1], pull_request: ['merged', 1] });
    for (const task of await t.tasks()) expect(task.completed_at).toBeNull();

    state(3, false);
    expect(await sync()).toMatchObject({ outcome: 'success', imported: 0 });
    expect(await marks()).toEqual({ issue: ['open', 0], pull_request: ['open', 0] });
  });

  test('取り込んでいない閉じた項目は取り込まない', async () => {
    const t = await setup();
    const c = await t.addConnection();
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 1, { id: 800001, state: 'closed' })];
    f.data.pulls = [fakePull(1, { state: 'closed' })];
    expect(await syncConnection(env, t.db, t.workspace.id, c.id, { fetcher: f.fetcher })).toMatchObject({
      imported: 0,
    });
    expect(await t.sources()).toHaveLength(0);
  });

  test('頁予算で Issue/PR の途中に止めても、次の同期で続きから取り込む', async () => {
    const t = await setup();
    const c = await t.addConnection();
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 1)];
    f.data.pulls = Array.from({ length: 250 }, (_, i) => fakePull(i + 1));
    let imported = 0;
    let more = false;
    for (let turn = 0; turn < 20; turn++) {
      const before = f.calls.length;
      const result = await syncConnection(env, t.db, t.workspace.id, c.id, {
        fetcher: f.fetcher,
        maxPages: 1,
        source: discoveryOnly,
      });
      expect(result.outcome).toBe('success');
      if (result.outcome !== 'success') throw new Error('同期が成功していない');
      imported += result.imported;
      more = result.more;
      // 保存境界を跨ぐ前に全頁を取得してしまわない。初回GET /userだけは追加されうる。
      expect(f.calls.length - before).toBeLessThanOrEqual(turn === 0 ? 2 : 1);
      if (!more) break;
    }
    expect(more).toBe(false);
    expect(imported).toBe(251);
    expect(await t.tasks()).toHaveLength(251);
    expect(new Set((await t.sources()).map((s) => `${s.source_kind}:${s.source_id}`)).size).toBe(251);
    const row = await t.db.first(
      t.db.statement((q) => q.selectFrom('connections').select('sync_state_json').where('id', '=', c.id)),
    );
    expect(row?.sync_state_json).toBe('{}');
  });
});
