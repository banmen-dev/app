import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import type { BrowserContext, Route } from '@playwright/test';
import { openPreviewBranches, publishPreview } from './deploy-preview.ts';
import { installDevOpenAccess } from './dev-open-access.ts';
import { resolveDevOpenTarget } from './dev-open-target.ts';
import { deployPreview, type PreviewDeps } from './preview-deploy.ts';

const SHA = 'a'.repeat(40);
const UUID = '11111111-1111-4111-8111-111111111111';

test('alias と Worker 名の DNS ラベルは63文字まで受け付け、64文字は問い合わせ前に断る', async () => {
  const fixedLength = 'pr--banmen-preview'.length;
  for (const labelLength of [63, 64]) {
    const number = '1'.repeat(labelLength - fixedLength);
    let externalCalls = 0;
    const deps: PreviewDeps = {
      env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: `${number}-preview` },
      commitSha: SHA,
      listDatabases: async () => {
        externalCalls++;
        return [];
      },
      createDatabase: async (name) => ({ name, uuid: UUID }),
      deleteDatabase: async () => assert.fail('初回なので削除しない'),
      openBranches: async () => [],
      publish: async (input) => {
        assert.equal(new URL(input.origin).hostname.split('.')[0].length, labelLength);
      },
      log: () => {},
    };
    if (labelLength === 63) {
      await deployPreview(deps);
      assert.equal(externalCalls, 1);
    } else {
      await assert.rejects(deployPreview(deps));
      assert.equal(externalCalls, 0);
    }
  }
});

for (const failureAt of ['execute', 'upload']) {
  test(`${failureAt} の起動例外は成功扱いにせず一時設定を消す`, () => {
    const commands: string[] = [];
    let configFile = '';
    const run = ((_command: string, args: string[]) => {
      commands.push(args[1]);
      configFile = args.at(-1)!;
      if (args[1] === failureAt) throw new Error('子プロセスを起動できない');
      return { status: 0 };
    }) as typeof spawnSync;
    assert.throws(() =>
      publishPreview({ number: '374', database: { name: 'banmen-pr-374', uuid: UUID }, commitSha: SHA }, run),
    );
    assert.deepEqual(
      commands,
      failureAt === 'execute' ? ['migrations', 'execute'] : ['migrations', 'execute', 'upload'],
    );
    assert.ok(!existsSync(configFile));
  });
}

for (const branch of ['main', '374-preview']) {
  test(`GitHubの後続ページが落ちても先頭ページだけでcleanupを始めない: ${branch}`, async () => {
    let requestedPages = 0;
    let deleted = false;
    const logs: string[] = [];
    const deps: PreviewDeps = {
      env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: branch },
      commitSha: SHA,
      // 掃除を打ち切ったときに続けるかを分けないよう、作らずに止まる数の D1 を置く。
      listDatabases: async () =>
        Array.from({ length: 8 }, (_, index) => ({
          name: `banmen-pr-${900 + index}`,
          uuid: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        })),
      createDatabase: async () => assert.fail('掃除できず D1 が多いので作成しない'),
      deleteDatabase: async () => {
        deleted = true;
      },
      openBranches: () =>
        openPreviewBranches(async () => {
          if (++requestedPages > 1) throw new Error('GitHub timeout');
          return Array.from({ length: 100 }, () => ({
            head: { ref: '275-feature', repo: { id: 1425341812, full_name: 'banmen-dev/app' } },
          }));
        }),
      publish: async () => assert.fail('掃除できず D1 が多いので公開しない'),
      log: (message) => logs.push(message),
    };
    await assert.rejects(deployPreview(deps));
    assert.equal(requestedPages, 2);
    assert.equal(deleted, false);
    assert.ok(logs.includes('閉じた PR の D1 の掃除を打ち切りました: 開いた PR を読めませんでした（Error）'));
  });
}

test('ブラウザの同一origin通信が失敗したらfulfillせずabortする', async () => {
  const origin = 'https://pr-374-banmen-preview.ucan-lab.workers.dev';
  const env = { CF_ACCESS_CLIENT_ID: 'test-id', CF_ACCESS_CLIENT_SECRET: 'test-secret' };
  const target = resolveDevOpenTarget(['--origin', origin], env);
  assert.ok(target.ok);
  let handler: Parameters<BrowserContext['route']>[1] | undefined;
  const context: Pick<BrowserContext, 'route'> = {
    route: async (_pattern, callback) => {
      handler = callback;
      return { async dispose() {}, async [Symbol.asyncDispose]() {} };
    },
  };
  await installDevOpenAccess(context, target, env);
  assert.ok(handler);
  let aborted = false;
  const route = {
    request: () => ({ url: () => `${origin}/api/me`, headers: () => ({}) }),
    fetch: async () => {
      throw new Error('Playwright error containing test-secret');
    },
    fulfill: async () => assert.fail('失敗した通信を成功扱いにしない'),
    abort: async () => {
      aborted = true;
    },
  } as unknown as Route;
  await handler(route, route.request());
  assert.equal(aborted, true);
});

test('UUID の前後の文字は拒否し、D1 名の前後の文字があるDBは掃除しない', async () => {
  for (const value of [`${UUID}\n`, `x${UUID}`, `${UUID}x`]) {
    let changes = 0;
    const deps: PreviewDeps = {
      env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
      commitSha: SHA,
      listDatabases: async () => [{ name: 'banmen-pr-374', uuid: value }],
      createDatabase: async (name) => {
        changes++;
        return { name, uuid: UUID };
      },
      deleteDatabase: async () => {
        changes++;
      },
      openBranches: async () => [],
      publish: async () => {
        changes++;
      },
      log: () => {},
    };
    await assert.rejects(deployPreview(deps));
    assert.equal(changes, 0, '例外の有無とは別に書き込みが無いことを確かめる');
  }
  for (const name of ['banmen-pr-374\n', 'x-banmen-pr-374', 'banmen-pr-374-backup']) {
    await deployPreview({
      env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' },
      commitSha: SHA,
      listDatabases: async () => [{ name, uuid: UUID }],
      createDatabase: async () => assert.fail('cleanupは作成しない'),
      deleteDatabase: async () => assert.fail('正確なプレビュー名でなければ削除しない'),
      openBranches: async () => [],
      publish: async () => assert.fail('cleanupは公開しない'),
      log: () => {},
    });
  }
});
