import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deployPreview,
  PREVIEW_CLEANUP_CONTINUE_BELOW,
  PreviewHttpError,
  type PreviewDatabase,
  type PreviewDeps,
} from './preview-deploy.ts';

const SHA = 'a'.repeat(40);
const PRODUCTION_ID = '55d9a51f-bb3f-483c-8051-1d867c0f9ce8';
const OLD = { name: 'banmen-pr-374', uuid: '11111111-1111-4111-8111-111111111111' };
const NEW = { name: OLD.name, uuid: '22222222-2222-4222-8222-222222222222' };
const OTHER = { name: 'banmen-pr-275', uuid: '33333333-3333-4333-8333-333333333333' };
const PROD = { name: 'banmen', uuid: PRODUCTION_ID };

function fake(overrides: Partial<PreviewDeps> = {}) {
  const events: string[] = [];
  const deleted: PreviewDatabase[] = [];
  const published: Parameters<PreviewDeps['publish']>[0][] = [];
  const logs: string[] = [];
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
      return ['275-task-complete', '374-preview'];
    },
    publish: async (input) => {
      events.push('publish');
      published.push(input);
    },
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps, events, deleted, published, logs };
}

test('自分の D1 だけを作り直し、新しい ID とコミットをプレビューへ渡す', async () => {
  const f = fake();
  await deployPreview(f.deps);
  assert.deepEqual(f.events, ['list', 'branches', `delete:${OLD.name}`, `create:${OLD.name}`, 'publish']);
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
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    openBranches: async () => ['275-task-complete'],
  });
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
  { ...NEW, name: 'banmen' },
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

// 番号付きのビルドの掃除（#1456）

const CLOSED_A = { name: 'banmen-pr-1426', uuid: '66666666-6666-4666-8666-666666666666' };
const CLOSED_B = { name: 'banmen-pr-1432', uuid: '77777777-7777-4777-8777-777777777777' };

function databasesOf(count: number): PreviewDatabase[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `banmen-pr-${900 + index}`,
    uuid: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
  }));
}

test('番号付きのビルドは、自分の D1 を作る前に閉じた PR の D1 を消す', async () => {
  const f = fake({ listDatabases: async () => [PROD, CLOSED_A, OLD, OTHER, CLOSED_B] });
  await deployPreview(f.deps);
  assert.deepEqual(f.events, [
    'branches',
    `delete:${CLOSED_A.name}`,
    `delete:${CLOSED_B.name}`,
    `delete:${OLD.name}`,
    `create:${OLD.name}`,
    'publish',
  ]);
  assert.deepEqual(f.deleted, [CLOSED_A, CLOSED_B, OLD]);
  assert.ok(f.logs.includes(`閉じた PR の D1 の掃除: 前 5 個、後 3 個、削除 ${CLOSED_A.name}, ${CLOSED_B.name}`));
});

test('番号付きのビルドは、開いた PR の D1 と改名前の D1 と D1 でないものを消さない', async () => {
  const legacy = { name: 'scrum-guild-pr-1426', uuid: '55555555-5555-4555-8555-555555555555' };
  const unrelated = { name: 'banmen-preview', uuid: '44444444-4444-4444-8444-444444444444' };
  const f = fake({ listDatabases: async () => [PROD, OTHER, legacy, unrelated] });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, []);
  assert.ok(f.logs.includes('閉じた PR の D1 の掃除: 前 4 個、後 4 個、削除 なし'));
  assert.equal(f.published.length, 1);
});

test('開いた PR の一覧に自分の番号が無ければ、一覧が欠けているとして何も消さない', async () => {
  const f = fake({ openBranches: async () => [] });
  await deployPreview(f.deps);
  // OTHER は残し、自分の D1 は作り直しの1回だけ消す。
  assert.deepEqual(f.events, ['list', `delete:${OLD.name}`, `create:${OLD.name}`, 'publish']);
  assert.ok(f.logs.includes('閉じた PR の D1 の掃除を打ち切りました: 開いた PR の一覧にこのビルドの番号がありません'));
});

test('番号付きのビルドは、同じ番号の別のブランチが開いていれば残す', async () => {
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: '275-another' },
    listDatabases: async () => [PROD, OLD, OTHER],
    openBranches: async () => ['275-task-complete', '374-preview', '275-another'],
    createDatabase: async (name) => ({ name, uuid: NEW.uuid }),
  });
  await deployPreview(f.deps);
  assert.deepEqual(f.deleted, [OTHER]);
});

const failures: [string, Partial<PreviewDeps>, string][] = [
  [
    'GitHub が 403',
    {
      openBranches: async () => {
        throw new PreviewHttpError(403);
      },
    },
    '開いた PR を読めませんでした（HTTP 403）',
  ],
  [
    'GitHub が 404',
    {
      openBranches: async () => {
        throw new PreviewHttpError(404);
      },
    },
    '開いた PR を読めませんでした（HTTP 404）',
  ],
  [
    'GitHub の一覧が不正',
    { openBranches: async () => [null] as unknown as string[] },
    '開いた PR を読めませんでした（開いた PR のブランチ一覧を読めませんでした）',
  ],
  [
    '本文を含む例外',
    {
      openBranches: async () => {
        throw new TypeError('fetch failed https://example.invalid/?token=secret');
      },
    },
    '開いた PR を読めませんでした（TypeError）',
  ],
];

for (const [label, overrides, reason] of failures) {
  test(`GitHub の失敗では何も消さず、D1 が ${PREVIEW_CLEANUP_CONTINUE_BELOW} 個未満なら配信を続ける: ${label}`, async () => {
    const databases = [PROD, ...databasesOf(PREVIEW_CLEANUP_CONTINUE_BELOW - 2)];
    const f = fake({ listDatabases: async () => databases, ...overrides });
    await deployPreview(f.deps);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.published.length, 1);
    assert.ok(f.logs.includes(`閉じた PR の D1 の掃除を打ち切りました: ${reason}`));
    assert.ok(f.logs.some((line) => line.startsWith('警告: ')));
    assert.ok(!f.logs.some((line) => line.includes('secret')));
  });

  test(`GitHub の失敗では何も消さず、D1 が ${PREVIEW_CLEANUP_CONTINUE_BELOW} 個以上なら作る前に止まる: ${label}`, async () => {
    const databases = [PROD, OLD, ...databasesOf(PREVIEW_CLEANUP_CONTINUE_BELOW - 2)];
    const f = fake({ listDatabases: async () => databases, ...overrides });
    await assert.rejects(deployPreview(f.deps));
    // 自分の D1 の作り直しも、作成もしない。
    assert.deepEqual(f.deleted, []);
    assert.ok(!f.events.some((event) => event.startsWith('create:')));
    assert.deepEqual(f.published, []);
    assert.ok(f.logs.includes(`閉じた PR の D1 の掃除を打ち切りました: ${reason}`));
  });
}

test('掃除の削除に失敗したら以降を消さず、消せた分を引いた数で続行を決める', async () => {
  let deletes = 0;
  // 閉じた D1 が 3 個、ほかに 6 個で計 9 個。1 個目を消し、2 個目で失敗すると 8 個残る。
  const closed = [CLOSED_A, CLOSED_B, { name: 'banmen-pr-1433', uuid: '88888888-8888-4888-8888-888888888888' }];
  const f = fake({
    listDatabases: async () => [PROD, OTHER, ...closed, ...databasesOf(4)],
    openBranches: async () => [
      '275-task-complete',
      '374-preview',
      ...databasesOf(4).map((db) => `${db.name.slice(10)}-x`),
    ],
    deleteDatabase: async (db) => {
      deletes++;
      f.events.push(`delete:${db.name}`);
      if (deletes === 2) throw new PreviewHttpError(500);
      f.deleted.push(db);
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.equal(deletes, 2);
  assert.deepEqual(f.deleted, [CLOSED_A]);
  assert.ok(!f.events.some((event) => event.startsWith('create:')));
  assert.ok(f.logs.includes(`閉じた PR の D1 の掃除: 前 9 個、後 8 個、削除 ${CLOSED_A.name}`));
  assert.ok(
    f.logs.includes(`閉じた PR の D1 の掃除を打ち切りました: ${CLOSED_B.name} を削除できませんでした（HTTP 500）`),
  );
});

test(`掃除で ${PREVIEW_CLEANUP_CONTINUE_BELOW} 個未満まで減らせたなら、削除に失敗しても続ける`, async () => {
  let deletes = 0;
  const closed = [CLOSED_A, CLOSED_B, { name: 'banmen-pr-1433', uuid: '88888888-8888-4888-8888-888888888888' }];
  const f = fake({
    listDatabases: async () => [PROD, OTHER, ...closed, ...databasesOf(3)],
    openBranches: async () => [
      '275-task-complete',
      '374-preview',
      ...databasesOf(3).map((db) => `${db.name.slice(10)}-x`),
    ],
    deleteDatabase: async (db) => {
      deletes++;
      if (deletes === 2) throw new PreviewHttpError(500);
      f.deleted.push(db);
    },
  });
  await deployPreview(f.deps);
  assert.equal(deletes, 2);
  assert.equal(f.published.length, 1);
});

test('main の掃除は GitHub の失敗をビルドの失敗にし、ログに理由を出す', async () => {
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    openBranches: async () => {
      throw new PreviewHttpError(403);
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.deepEqual(f.deleted, []);
  assert.ok(f.logs.includes('閉じた PR の D1 の掃除を打ち切りました: 開いた PR を読めませんでした（HTTP 403）'));
});

test('並行するビルドが先に消した D1 の 404 では打ち切らずに掃除を続け、消せた数には入れない', async () => {
  const closed = Array.from({ length: 8 }, (_, index) => ({
    name: `banmen-pr-${1001 + index}`,
    uuid: `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`,
  }));
  const f = fake({
    listDatabases: async () => closed,
    openBranches: async () => ['374-preview'],
    deleteDatabase: async (db) => {
      f.events.push(`delete:${db.name}`);
      if (db.name === closed[0].name) throw new PreviewHttpError(404);
      f.deleted.push(db);
    },
  });
  await deployPreview(f.deps);
  assert.equal(f.events.filter((event) => event.startsWith('delete:')).length, 8);
  assert.ok(f.logs.includes(`削除が 404 を返しました（既に消えたと見て続けます）: ${closed[0].name}`));
  // 404 は消えたと確かめていないので、後の数から引かない。
  assert.ok(
    f.logs.some(
      (line) =>
        line.startsWith('閉じた PR の D1 の掃除: 前 8 個、後 1 個、') && line.endsWith(`、404 ${closed[0].name}`),
    ),
  );
  assert.equal(f.published.length, 1);
});

test('自分の D1 の作り直しで 404 なら、消えているものとして作る', async () => {
  const f = fake({
    deleteDatabase: async (db) => {
      f.events.push(`delete:${db.name}`);
      throw new PreviewHttpError(404);
    },
  });
  await deployPreview(f.deps);
  assert.deepEqual(f.events, ['list', 'branches', `delete:${OLD.name}`, `create:${OLD.name}`, 'publish']);
  assert.ok(f.logs.includes(`削除が 404 を返しました（既に消えたと見て続けます）: ${OLD.name}`));
  assert.equal(f.published.length, 1);
});

for (const status of [400, 403, 500]) {
  test(`自分の D1 の作り直しで 404 以外の ${status} なら作らない`, async () => {
    const f = fake({
      deleteDatabase: async () => {
        throw new PreviewHttpError(status);
      },
    });
    await assert.rejects(deployPreview(f.deps));
    assert.ok(!f.events.some((event) => event.startsWith('create:')));
  });
}

test('404 で済ませた D1 は残りの数から引かず、閾値を通り抜けない', async () => {
  // 閉じた D1 が 3 個（2 個は 404）、ほかに開いた 6 個で計 9 個。3 個目の削除で失敗して打ち切る。
  const closed = [CLOSED_A, CLOSED_B, { name: 'banmen-pr-1433', uuid: '88888888-8888-4888-8888-888888888888' }];
  const open = databasesOf(5);
  const f = fake({
    listDatabases: async () => [OTHER, ...closed, ...open],
    openBranches: async () => ['275-task-complete', '374-preview', ...open.map((db) => `${db.name.slice(10)}-x`)],
    deleteDatabase: async (db) => {
      f.events.push(`delete:${db.name}`);
      if (db.name === closed[2].name) throw new PreviewHttpError(500);
      throw new PreviewHttpError(404);
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.ok(!f.events.some((event) => event.startsWith('create:')));
  assert.ok(f.logs.some((line) => line.startsWith('閉じた PR の D1 の掃除: 前 9 個、後 9 個、削除 なし、404 ')));
});

test(`開いた PR の一覧に自分の番号が無く、D1 が ${PREVIEW_CLEANUP_CONTINUE_BELOW} 個以上なら作る前に止まる`, async () => {
  const f = fake({
    listDatabases: async () => [OLD, ...databasesOf(PREVIEW_CLEANUP_CONTINUE_BELOW - 1)],
    openBranches: async () => ['275-task-complete'],
  });
  await assert.rejects(deployPreview(f.deps));
  // 掃除で何も消さず、自分の D1 も消しも作りもしない。
  assert.deepEqual(f.events, []);
  assert.ok(f.logs.includes('閉じた PR の D1 の掃除を打ち切りました: 開いた PR の一覧にこのビルドの番号がありません'));
});

test(`閉じた D1 の削除がすべて 404 で、D1 が ${PREVIEW_CLEANUP_CONTINUE_BELOW} 個以上残るなら作る前に止まる`, async () => {
  const closed = Array.from({ length: PREVIEW_CLEANUP_CONTINUE_BELOW }, (_, index) => ({
    name: `banmen-pr-${1001 + index}`,
    uuid: `${String(index).padStart(8, '0')}-3333-4333-8333-333333333333`,
  }));
  const f = fake({
    listDatabases: async () => [OLD, ...closed],
    openBranches: async () => ['374-preview'],
    deleteDatabase: async (db) => {
      f.events.push(`delete:${db.name}`);
      throw new PreviewHttpError(404);
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.ok(!f.events.includes(`delete:${OLD.name}`));
  assert.ok(!f.events.some((event) => event.startsWith('create:')));
  assert.deepEqual(f.published, []);
});

test(`閉じた D1 の削除が 404 でも、D1 が ${PREVIEW_CLEANUP_CONTINUE_BELOW} 個未満なら警告して続ける`, async () => {
  const f = fake({
    listDatabases: async () => [OLD, CLOSED_A],
    deleteDatabase: async (db) => {
      f.events.push(`delete:${db.name}`);
      if (db.name === CLOSED_A.name) throw new PreviewHttpError(404);
    },
  });
  await deployPreview(f.deps);
  assert.ok(f.logs.some((line) => line.startsWith('警告: D1 が 2 個')));
  assert.equal(f.published.length, 1);
});

test('main の掃除で 404 の D1 があれば、ビルドを失敗にして人に見せる', async () => {
  const f = fake({
    env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
    openBranches: async () => ['275-task-complete'],
    deleteDatabase: async () => {
      throw new PreviewHttpError(404);
    },
  });
  await assert.rejects(deployPreview(f.deps));
  assert.ok(f.logs.some((line) => line.startsWith('閉じた PR の D1 の掃除: 前 3 個、後 3 個、削除 なし、404 ')));
});
