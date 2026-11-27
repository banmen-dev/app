// Issue だけ読める PAT で PR の失敗を成功に見せず、権限回復後に同じ接続を再開する。
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
  const id = uuidv7();
  const sealed = await encryptCredential(env, PULL_PAT, id);
  const connection = await createConnection(organization, workspace.id, owner.id, {
    id,
    credential_ciphertext: sealed.ciphertext,
    credential_key_version: sealed.keyVersion,
    credential_last4: PULL_PAT.slice(-4),
  });
  for (const scope of [PULL_SCOPE, { id: '1002', name: 'guild-fake/beta' }]) {
    await createConnectionScope(organization, id, { source_id: scope.id, source_name: scope.name });
  }
  const tasks = () =>
    db.rows(db.statement((q) => q.selectFrom('tasks').selectAll().where('workspace_id', '=', workspace.id)));
  const sources = () =>
    db.rows(db.statement((q) => q.selectFrom('task_sources').selectAll().where('workspace_id', '=', workspace.id)));
  const current = async () => {
    const row = await db.first(db.statement((q) => q.selectFrom('connections').selectAll().where('id', '=', id)));
    if (!row) throw new Error('接続が見つからない');
    return row;
  };
  return { db, workspace, connection, tasks, sources, current };
}

describe('PR 一覧の権限不足と範囲の読み取り失敗', () => {
  test.each([
    [403, '取り込み元が権限を認めなかった'],
    [404, '取り込み元に届かないか、応答が想定と違う'],
    [410, '取り込み元に届かないか、応答が想定と違う'],
  ])('%i は接続を停止せず失敗にし、権限回復後に残りを再開する', async (status, message) => {
    const t = await setup();
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 1)];
    f.data.pulls = [fakePull(1)];
    f.data.pullFailure = status;
    const laterCalls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/repositories/1002/')) {
        laterCalls.push(url.pathname);
        return Response.json(url.pathname.endsWith('/issues') ? [fakeIssue('guild-fake/beta', 9)] : []);
      }
      return f.fetcher(input, init);
    };
    const sync = (maxPages?: number) =>
      syncConnection(env, t.db, t.workspace.id, t.connection.id, { fetcher, maxPages, source: discoveryOnly });

    // 最初の走査では Issue の保存まで成功し、PR の失敗で後続範囲を読む前に止まる。
    expect(await sync()).toEqual({ outcome: 'error', imported: 1 });
    expect(f.calls.some((c) => new URL(c.url).pathname.endsWith('/issues'))).toBe(true);
    expect(laterCalls).toEqual([]);
    const importedTasks = await t.tasks();
    const importedSources = await t.sources();
    expect(importedTasks).toHaveLength(1);
    expect(importedSources.map((s) => `${s.source_kind}:${s.source_id}`)).toEqual(['issue:500001']);
    expect(await t.current()).toMatchObject({
      status: 'error',
      stopped_reason: null,
      last_error_message: message,
      consecutive_failures: 1,
    });
    expect(JSON.stringify(await t.current())).not.toContain(PULL_PAT);

    // 既に保存済みの非空カーソルがある場合にも、失敗で消したり先へ進めたりしない。
    const checkpoint = (await t.current()).sync_state_json;
    expect(checkpoint).not.toBe('{}');
    expect(JSON.parse(checkpoint)).toMatchObject({
      version: 2,
      position: { scope: PULL_SCOPE.id, phase: 'items', cursor: 'v3:pulls:42:fake-ranger:1' },
    });
    expect(await sync(1)).toEqual({ outcome: 'error', imported: 0 });
    expect(await sync()).toEqual({ outcome: 'error', imported: 0 });
    expect((await t.current()).sync_state_json).toBe(checkpoint);
    expect((await t.current()).last_error_message).toBe(message);
    expect(await t.tasks()).toEqual(importedTasks);
    expect(await t.sources()).toEqual(importedSources);
    expect(laterCalls).toEqual([]);

    // 同じ接続のまま PAT の読取権限が回復すれば、不足 PR と後続範囲が届く。
    f.data.pullFailure = 0;
    expect(await sync()).toEqual({ outcome: 'success', imported: 2, more: false });
    expect(laterCalls).toEqual(['/repositories/1002/issues', '/repositories/1002/pulls', '/repositories/1002/pulls']);
    expect((await t.sources()).map((s) => `${s.source_kind}:${s.source_id}`).sort()).toEqual([
      'issue:500001',
      'issue:500009',
      'pull_request:800001',
    ]);
    expect(await t.tasks()).toHaveLength(3);
    expect(await t.current()).toMatchObject({
      status: 'active',
      stopped_reason: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      sync_state_json: '{}',
    });
    expect(await sync()).toEqual({ outcome: 'success', imported: 0, more: false });
    expect(await t.tasks()).toHaveLength(3);
  });
});
