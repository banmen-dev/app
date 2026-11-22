import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { openPreviewBranches, publishPreview } from './deploy-preview.ts';
import {
  PREVIEW_DATABASE_PREFIX,
  PREVIEW_TRIGGER_WORKER_NAME,
  PREVIEW_WORKER_NAME,
} from '../src/shared/preview-cloudflare.ts';
import { previewConfig, PRODUCTION_DATABASE_ID } from './preview-config.ts';

const SHA = 'a'.repeat(40);
const DB = { name: 'banmen-pr-374', uuid: '11111111-1111-4111-8111-111111111111' };

test('ランタイムと資産・bindingの共通設定は本番とずれない', () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  assert.equal(parsed.error, undefined);
  const production = parsed.config as ReturnType<typeof previewConfig> & {
    r2_buckets: { binding: string; bucket_name: string }[];
  };
  const preview = previewConfig('374', DB, SHA, '/workspace/app');
  assert.deepEqual(
    Object.keys(preview).sort(),
    Object.keys(production)
      .filter((key) => key !== '$schema' && key !== 'r2_buckets')
      .sort(),
  );
  assert.equal(preview.compatibility_date, production.compatibility_date);
  assert.equal(preview.send_metrics, production.send_metrics);
  assert.equal(preview.main, `/workspace/app/${production.main}`);
  assert.equal(preview.assets.directory, path.resolve('/workspace/app', production.assets.directory));
  assert.deepEqual(preview.assets, { ...production.assets, directory: preview.assets.directory });
  assert.equal(preview.d1_databases[0].binding, production.d1_databases[0].binding);
  assert.equal(preview.d1_databases.length, production.d1_databases.length);
  assert.equal(preview.d1_databases[0].migrations_dir, `/workspace/app/${production.d1_databases[0].migrations_dir}`);
  assert.deepEqual(production.r2_buckets, [{ binding: 'ATTACHMENTS', bucket_name: 'scrum-guild-attachments' }]);
  assert.deepEqual(preview.observability, production.observability);
});

test('起動専用 Worker の名前は共通の定数と一致する', () => {
  const text = readFileSync(new URL('../wrangler.preview-trigger.jsonc', import.meta.url), 'utf8');
  const parsed = ts.parseConfigFileTextToJson('wrangler.preview-trigger.jsonc', text);
  assert.equal(parsed.error, undefined);
  assert.equal((parsed.config as { name: string }).name, PREVIEW_TRIGGER_WORKER_NAME);
  assert.equal(PREVIEW_TRIGGER_WORKER_NAME, 'banmen-preview-trigger');
});

test('名前は正規表現にそのまま埋め込める形', () => {
  for (const name of [PREVIEW_WORKER_NAME, PREVIEW_TRIGGER_WORKER_NAME, PREVIEW_DATABASE_PREFIX]) {
    assert.match(name, /^[a-z0-9-]+$/);
  }
});

test('設定は alias のラベルが63文字までの番号だけを受け付ける', () => {
  const config = (digits: number) => {
    const number = '1'.repeat(digits);
    return previewConfig(number, { ...DB, name: `banmen-pr-${number}` }, SHA, '/workspace/app');
  };
  assert.equal(new URL(config(45).vars.PUBLIC_ORIGIN).hostname.split('.')[0].length, 63);
  assert.throws(() => config(46));
});

test('改名前の名前の D1 では設定を作らない', () => {
  assert.throws(() => previewConfig('374', { ...DB, name: 'scrum-guild-pr-374' }, SHA, '/workspace/app'));
});

test('拒否する本番IDは本番の設定と一致する', () => {
  const production = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const ids = [...production.matchAll(/"database_id"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, [PRODUCTION_DATABASE_ID]);
});

test('設定は本番の binding を持たず、cron と呼び出しログを無効にする', () => {
  const config = previewConfig('374', DB, SHA, '/workspace/app');
  assert.equal(config.name, 'banmen-preview');
  assert.equal(config.vars.PUBLIC_ORIGIN, 'https://pr-374-banmen-preview.ucan-lab.workers.dev');
  assert.equal(config.vars.APP_VERSION, SHA);
  assert.equal(config.vars.OPERATOR_LOGIN_IDS, 'github:9000000000000001');
  assert.deepEqual(config.d1_databases, [
    { binding: 'DB', database_name: DB.name, database_id: DB.uuid, migrations_dir: '/workspace/app/migrations' },
  ]);
  assert.equal('r2_buckets' in config, false);
  assert.deepEqual(config.vars, {
    APP_VERSION: SHA,
    PUBLIC_ORIGIN: 'https://pr-374-banmen-preview.ucan-lab.workers.dev',
    OPERATOR_LOGIN_IDS: 'github:9000000000000001',
    PREVIEW_WITHOUT_ATTACHMENTS: '1',
  });
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.triggers.crons, []);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.preview_urls, true);
});

test('設定生成は本番・別番号のDBと不正な版や番号を拒否する', () => {
  for (const [number, database, sha] of [
    ['374', { ...DB, uuid: PRODUCTION_DATABASE_ID }, SHA],
    ['374', { ...DB, name: 'scrum-guild' }, SHA],
    ['275', DB, SHA],
    ['374\n', { ...DB, name: 'banmen-pr-374\n' }, SHA],
    ['374', DB, SHA + '\n'],
    ['374', { ...DB, uuid: DB.uuid + '\n' }, SHA],
  ] as const)
    assert.throws(() => previewConfig(number, database, sha, '/workspace/app'));
});

test('公開前に新規D1へ全マイグレーションとseedを当て、プレビューaliasだけuploadする', () => {
  const calls: string[][] = [];
  let temporaryConfigFile = '';
  const run: typeof spawnSync = ((command: string, args: string[]) => {
    assert.ok(command.endsWith('/node_modules/.bin/wrangler'));
    calls.push(args.slice(0, -2));
    const configFile = args.at(-1)!;
    temporaryConfigFile = configFile;
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(config.d1_databases[0].database_id, DB.uuid);
    if (args[1] === 'execute') {
      const sql = readFileSync(args[args.indexOf('--file') + 1], 'utf8');
      assert.match(sql, /INSERT INTO sessions/);
      assert.match(sql, /INSERT INTO accounts/);
      assert.ok(!sql.includes('DELETE FROM'));
    }
    return { status: 0 };
  }) as typeof spawnSync;
  publishPreview({ number: '374', database: DB, commitSha: SHA }, run);
  assert.deepEqual(calls[0], ['d1', 'migrations', 'apply', 'DB', '--remote']);
  assert.deepEqual(calls[1].slice(0, 5), ['d1', 'execute', 'DB', '--remote', '--file']);
  assert.deepEqual(calls[2], ['versions', 'upload', '--preview-alias', 'pr-374']);
  assert.ok(!existsSync(temporaryConfigFile));
});

test('マイグレーション失敗後はseedやuploadをせず一時ファイルを片付ける', () => {
  let calls = 0;
  let configFile = '';
  const run = ((_command: string, args: string[]) => {
    calls++;
    configFile = args.at(-1)!;
    return { status: 1 };
  }) as typeof spawnSync;
  assert.throws(() => publishPreview({ number: '374', database: DB, commitSha: SHA }, run));
  assert.equal(calls, 1);
  assert.ok(!existsSync(configFile));
});

const REPOSITORY_ID = 1425341812;

test('GitHubは全ページを取得し、forkのPRを生存中の根拠にしない', async () => {
  const urls: string[] = [];
  const branches = await openPreviewBranches(async (url) => {
    urls.push(url);
    const own = { head: { ref: '374-preview', repo: { id: REPOSITORY_ID, full_name: 'scrum-guild-dev/app' } } };
    return urls.length === 1
      ? Array.from({ length: 100 }, () => own)
      : [{ head: { ref: '275-x', repo: { id: 9, full_name: 'someone/fork' } } }];
  });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /page=2$/);
  assert.equal(branches.length, 100);
  assert.ok(branches.every((branch) => branch === '374-preview'));
});

test('開いたPRの一覧は名前でなくリポジトリIDの宛先で読む', async () => {
  const urls: string[] = [];
  await openPreviewBranches(async (url) => {
    urls.push(url);
    return urls.length === 1
      ? Array.from({ length: 100 }, () => ({
          head: { ref: '374-preview', repo: { id: REPOSITORY_ID, full_name: 'scrum-guild-dev/app' } },
        }))
      : [];
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repositories/1425341812/pulls?state=open&per_page=100&page=1',
    'https://api.github.com/repositories/1425341812/pulls?state=open&per_page=100&page=2',
  ]);
  assert.ok(urls.every((url) => !url.includes('/repos/')));
});

test('リポジトリ名が改名後でも、IDが同じならPRのブランチを数える', async () => {
  const branches = await openPreviewBranches(async () => [
    { head: { ref: '374-preview', repo: { id: REPOSITORY_ID, full_name: 'renamed-guild/app' } } },
    { head: { ref: '375-preview', repo: { id: REPOSITORY_ID } } },
  ]);
  assert.deepEqual(branches, ['374-preview', '375-preview']);
});

test('名前が同じでもIDが異なるforkのPRは数えない', async () => {
  const branches = await openPreviewBranches(async () => [
    { head: { ref: '275-task', repo: { id: REPOSITORY_ID + 1, full_name: 'scrum-guild-dev/app' } } },
    { head: { ref: '374-preview', repo: { id: REPOSITORY_ID, full_name: 'scrum-guild-dev/app' } } },
  ]);
  assert.deepEqual(branches, ['374-preview']);
});

test('削除済みforkは掃除を止めず、同じ番号の自リポジトリのPRだけ残す', async () => {
  const branches = await openPreviewBranches(async () => [
    { head: { ref: '275-task', repo: null } },
    { head: { ref: '374-preview', repo: { id: REPOSITORY_ID, full_name: 'scrum-guild-dev/app' } } },
  ]);
  assert.deepEqual(branches, ['374-preview']);
});

test('GitHubの欠落・不明な応答を空の一覧として扱わない', async () => {
  for (const value of [
    {},
    [{ head: { ref: '374-preview' } }],
    [{ head: { ref: '374-preview', repo: 1 } }],
    [{ head: { ref: '374-preview', repo: {} } }],
    [{ head: { ref: '374-preview', repo: { full_name: 1 } } }],
  ]) {
    await assert.rejects(openPreviewBranches(async () => value));
  }
});

test('head.repo.id が無い・数値でない応答は、名前が同じでも例外にする', async () => {
  for (const repo of [
    { full_name: 'scrum-guild-dev/app' },
    { id: '1425341812', full_name: 'scrum-guild-dev/app' },
    { id: null, full_name: 'scrum-guild-dev/app' },
    { id: [REPOSITORY_ID], full_name: 'scrum-guild-dev/app' },
  ]) {
    await assert.rejects(
      openPreviewBranches(async () => [{ head: { ref: '374-preview', repo } }]),
      /開いた PR のブランチを読めませんでした/,
      JSON.stringify(repo),
    );
  }
});

test('デプロイの入口はWorkers Buildsの外で失敗し、認証情報を出さない', () => {
  const result = spawnSync(process.execPath, ['scripts/deploy-preview.ts'], {
    encoding: 'utf8',
    env: { ...process.env, WORKERS_CI: undefined },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /プレビューの処理に失敗/);
  assert.equal(result.stdout, '');
});
