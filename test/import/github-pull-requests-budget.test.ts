// 本物の同期の保存・再開と、偽 GitHub の取得をつなぐ #1312 の受け入れテスト。
import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
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

describe('同期の項目取得予算', () => {
  test('時間予算0なら要求せず未処理位置を保存する', async () => {
    const t = await setup();
    const connection = await t.addConnection();
    const f = ownPullFixture();
    expect(
      await syncConnection(env, t.db, t.workspace.id, connection.id, { fetcher: f.fetcher, maxDurationMs: 0 }),
    ).toEqual({ outcome: 'success', imported: 0, more: true });
    expect(f.calls).toHaveLength(0);
    const row = await t.db.first(
      t.db.statement((q) => q.selectFrom('connections').select('sync_state_json').where('id', '=', connection.id)),
    );
    expect(JSON.parse(row!.sync_state_json)).toMatchObject({
      version: 2,
      position: { scope: PULL_SCOPE.id, cursor: null },
    });
  });

  test('Issueの取得で60秒に達したらPRを開始せず、次回そのPR段階から再開する', async () => {
    const t = await setup();
    const connection = await t.addConnection();
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 1)];
    f.data.pulls = [fakePull(1)];
    const start = Date.now();
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => start + elapsed);
    const fetcher: typeof fetch = async (input, init) => {
      const response = await f.fetcher(input, init);
      if (String(input).includes('/issues?')) elapsed = 60_000;
      return response;
    };
    try {
      expect(await syncConnection(env, t.db, t.workspace.id, connection.id, { fetcher })).toEqual({
        outcome: 'success',
        imported: 1,
        more: true,
      });
      expect(f.calls).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
    const before = f.calls.length;
    expect(
      await syncConnection(env, t.db, t.workspace.id, connection.id, { fetcher: f.fetcher, source: discoveryOnly }),
    ).toEqual({
      outcome: 'success',
      imported: 1,
      more: false,
    });
    expect(f.calls.length - before).toBe(3); // PR1要求＋レビュー本人照会・空の全走査2要求
    expect(new URL(f.calls.at(-1)!.url).pathname).toBe('/repositories/1001/pulls');
    expect(await t.tasks()).toHaveLength(2);
  });
});
