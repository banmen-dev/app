import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployPreview, type PreviewDatabase, type PreviewDeps } from './preview-deploy.ts';

const SHA = 'a'.repeat(40);
const PRODUCTION_ID = '7fc32f51-8771-4122-aa5d-3b69c07ff861';
const OLD = { name: 'banmen-pr-374', uuid: '11111111-1111-4111-8111-111111111111' };
const NEW = { name: OLD.name, uuid: '22222222-2222-4222-8222-222222222222' };
const OTHER = { name: 'banmen-pr-275', uuid: '33333333-3333-4333-8333-333333333333' };
const PROD = { name: 'scrum-guild', uuid: PRODUCTION_ID };

function fake(overrides: Partial<PreviewDeps> = {}) {
  const events: string[] = [];
  const deleted: PreviewDatabase[] = [];
  const published: Parameters<PreviewDeps['publish']>[0][] = [];
  const deps: PreviewDeps = {
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: '374-preview' },
    commitSha: SHA,
    listDatabases: async () => {
      events.push('list');
      return [PROD, OLD, OTHER];
    },
    createDatabase: async (name) => {
      events.push(`create:${name}`);
      return NEW;
    },
    deleteDatabase: async (db) => {
      events.push(`delete:${db.name}`);
      deleted.push(db);
    },
    openBranches: async () => {
      events.push('branches');
      return ['275-task-complete'];
    },
    publish: async (input) => {
      events.push('publish');
      published.push(input);
    },
    log: () => {},
    ...overrides,
  };
  return { deps, events, deleted, published };
}

test('自分の D1 だけを作り直し、新しい ID とコミットをプレビューへ渡す', async () => {
  const f = fake();
  await deployPreview(f.deps);
  assert.deepEqual(f.events, ['list', `delete:${OLD.name}`, `create:${OLD.name}`, 'publish']);
  assert.deepEqual(f.deleted, [OLD]);
  assert.deepEqual(f.published, [
    { number: '374', origin: 'https://pr-374-banmen-preview.ucan-lab.workers.dev', database: NEW, commitSha: SHA },
  ]);
});

test('初回は削除せず D1 を作る', async () => {
  const f = fake({ listDatabases: async () => [PROD, OTHER] });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.published.length, 1);
});

for (const branch of ['374-preview', '374-feature/nested', '374-A_1']) {
  test(`番号付きブランチを受け付ける: ${branch}`, async () => {
    const f = fake({ env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: branch } });
    await deployPreview(f.deps);
    assert.equal(f.published[0]?.number, '374');
  });
}

for (const workersCi of [undefined, '', '0', 'true', '01']) {
  test(`Workers Builds 以外では問い合わせ前に断る: ${workersCi}`, async () => {
    const f = fake({ env: { WORKERS_CI: workersCi, WORKERS_CI_BRANCH: '374-preview' } });
    await assert.rejects(deployPreview(f.deps));
    assert.deepEqual(f.events, []);
  });
}

for (const branch of [
  undefined,
  '',
  'production',
  '374',
  '0-preview',
  '0374-preview',
  '-374-preview',
  '374--preview',
  '374-../x',
  '374-x;echo',
  'refs/heads/374-preview',
]) {
  test(`不明なブランチを問い合わせ前に断る: ${branch}`, async () => {
    const f = fake({ env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: branch } });
    await assert.rejects(deployPreview(f.deps));
    assert.deepEqual(f.events, []);
  });
}

for (const branch of ['main', '374-preview']) {
  for (const commitSha of ['', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'main', `${SHA}\n`]) {
    test(`SHA 不正で副作用前に断る: ${branch} ${commitSha.length}`, async () => {
      const f = fake({ commitSha, env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: branch } });
      await assert.rejects(deployPreview(f.deps));
      assert.deepEqual(f.events, []);
    });
  }
}

test('main は閉じた PR の D1 だけを消し、作成とアップロードをしない', async () => {
  const f = fake({ env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' } });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, [OLD]);
  assert.deepEqual(f.published, []);
  assert.ok(!f.events.some((event) => event.startsWith('create:')));
});

test('開いた PR がなければプレビューの D1 だけ消す', async () => {
  const unrelated = { name: 'banmen-preview', uuid: '44444444-4444-4444-8444-444444444444' };
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    listDatabases: async () => [PROD, OLD, OTHER, unrelated],
    openBranches: async () => [],
  });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, [OLD, OTHER]);
});

test('改名前の接頭辞の D1 は掃除の対象にしない（人が専用アカウントで消す）', async () => {
  const legacy = { name: 'scrum-guild-pr-275', uuid: '55555555-5555-4555-8555-555555555555' };
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    listDatabases: async () => [PROD, OLD, legacy],
    openBranches: async () => [],
  });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, [OLD]);
});

test('同じ番号の別の開いたブランチも生存中として残す', async () => {
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    openBranches: async () => ['374-other-name', '275-task-complete'],
  });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, []);
});

test('非番号ブランチが開いていても他のプレビューを守る根拠にはしない', async () => {
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    openBranches: async () => ['feature', 'production', '0374-preview'],
  });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, [OLD, OTHER]);
});

for (const branch of ['main', '374-preview']) {
  const invalidLists: [string, unknown][] = [
    ['non-array', {}],
    ['null-entry', [OLD, null]],
    ['missing-name', [OLD, { uuid: OTHER.uuid }]],
    ['bad-id', [OLD, { name: OTHER.name, uuid: 'not-a-uuid' }]],
    ['duplicate-name', [OLD, { ...NEW, name: OLD.name }]],
    ['duplicate-id', [OLD, { ...OTHER, uuid: OLD.uuid }]],
    ['preview-with-production-id', [{ ...OLD, uuid: PRODUCTION_ID }]],
  ];
  for (const [name, databases] of invalidLists) {
    test(`一覧不正で変更前に断る: ${branch} ${name}`, async () => {
      const f = fake({
        env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: branch },
        listDatabases: async () => databases as PreviewDatabase[],
      });
      await assert.rejects(deployPreview(f.deps));
      assert.deepEqual(f.deleted, []);
      assert.deepEqual(f.published, []);
      assert.ok(!f.events.some((event) => event.startsWith('create:')));
    });
  }
}

for (const invalid of [null, {}, ['374-preview', null], ['374-preview', 374]]) {
  test(`GitHub の枝一覧不正では削除しない: ${JSON.stringify(invalid)}`, async () => {
    const f = fake({
      env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
      openBranches: async () => invalid as string[],
    });
    await assert.rejects(deployPreview(f.deps));
    assert.deepEqual(f.deleted, []);
  });
}

test('GitHub の取得失敗では削除しない', async () => {
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    openBranches: async () => {
      throw new Error('GitHub unavailable');
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.deepEqual(f.deleted, []);
});

for (const invalid of [
  { ...NEW, name: 'scrum-guild' },
  { ...NEW, uuid: PRODUCTION_ID },
  { ...NEW, uuid: 'invalid' },
  { ...NEW, name: OTHER.name },
  { ...NEW, uuid: OTHER.uuid },
]) {
  test(`作成した D1 が対象と合わなければアップロードしない: ${JSON.stringify(invalid)}`, async () => {
    const f = fake({ createDatabase: async () => invalid });
    await assert.rejects(deployPreview(f.deps));
    assert.deepEqual(f.published, []);
  });
}

test('一覧取得失敗後には何も消さない', async () => {
  const f = fake({
    listDatabases: async () => {
      throw new Error('D1 unavailable');
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.deepEqual(f.deleted, []);
  assert.deepEqual(f.published, []);
});

test('削除失敗後は作成せずアップロードしない', async () => {
  const f = fake({
    deleteDatabase: async () => {
      throw new Error('delete failed');
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.ok(!f.events.some((event) => event.startsWith('create:')));
  assert.deepEqual(f.published, []);
});

test('作成失敗後はアップロードしない', async () => {
  const f = fake({
    createDatabase: async () => {
      throw new Error('create failed');
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.deepEqual(f.published, []);
});

test('アップロード失敗を成功扱いにしない', async () => {
  const f = fake({
    publish: async () => {
      throw new Error('upload failed');
    },
  });
  await assert.rejects(deployPreview(f.deps));
});

test('cleanup の削除に失敗したら以降の削除をしない', async () => {
  let deletes = 0;
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    openBranches: async () => [],
    deleteDatabase: async () => {
      deletes++;
      throw new Error('delete failed');
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.equal(deletes, 1);
});
