// Workers Builds 専用。セッションから実行しない。API とコマンドは deploy-preview.test.ts、手順は preview-deploy.test.ts で確かめる。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { PREVIEW_REPOSITORY_ID } from '../src/server/preview-trigger/webhook.ts';
import { isIsolatedPreviewAccount, isIsolatedPreviewSubdomain } from '../src/shared/preview-cloudflare.ts';
import { deployPreview, PreviewHttpError, PreviewStepError, type PreviewDatabase } from './preview-deploy.ts';
import { previewConfig } from './preview-config.ts';
import { seedSql } from './seed.ts';

// JSON 以外のエラー本文や認証情報をログに流さない。
async function jsonRequest(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PreviewHttpError(response.status);
  }
  return response.json();
}

export async function openPreviewBranches(fetchJson = jsonRequest): Promise<string[]> {
  const branches: string[] = [];
  for (let page = 1; ; page++) {
    const data = await fetchJson(
      `https://api.github.com/repositories/${PREVIEW_REPOSITORY_ID}/pulls?state=open&per_page=100&page=${page}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'banmen-preview' },
      },
    );
    if (!Array.isArray(data)) throw new PreviewStepError('開いた PR の一覧を読めませんでした');
    for (const pr of data) {
      if (typeof pr?.head?.ref !== 'string') {
        throw new PreviewStepError('開いた PR のブランチを読めませんでした');
      }
      // 元の fork が削除された PR は repo:null になる。同じリポジトリのブランチではない。
      if (pr.head.repo === null) continue;
      if (!Number.isSafeInteger(pr.head.repo?.id)) throw new PreviewStepError('開いた PR のブランチを読めませんでした');
      // 組織の改名で止まらないよう、名前でなく起動専用 Worker と同じリポジトリ ID で照合する。
      if (pr.head.repo.id === PREVIEW_REPOSITORY_ID) branches.push(pr.head.ref);
    }
    if (data.length < 100) return branches;
  }
}

export function publishPreview(
  input: { number: string; database: PreviewDatabase; commitSha: string; subdomain?: string },
  run = spawnSync,
) {
  const root = process.cwd();
  // 設定を検査してから一時ファイルやコマンドを作る。
  const config = previewConfig(input.number, input.database, input.commitSha, root, input.subdomain);
  const directory = mkdtempSync(path.join(tmpdir(), 'banmen-preview-'));
  try {
    const configFile = path.join(directory, 'wrangler.json');
    const seedFile = path.join(directory, 'seed.sql');
    writeFileSync(configFile, JSON.stringify(config));
    // 新規 D1 なので削除対象の表はない。ローカルと同じ seed の生成関数で期限を入れる。
    writeFileSync(
      seedFile,
      seedSql([], readFileSync(path.join(root, 'seed/data.sql'), 'utf8'), Object.values(SEED_SESSIONS), new Date()),
    );
    const commands = [
      ['d1', 'migrations', 'apply', 'DB', '--remote'],
      ['d1', 'execute', 'DB', '--remote', '--file', seedFile],
      ['versions', 'upload', '--preview-alias', `pr-${input.number}`],
    ];
    for (const args of commands) {
      const result = run(path.join(root, 'node_modules/.bin/wrangler'), [...args, '--config', configFile], {
        stdio: ['ignore', 'inherit', 'inherit'],
        encoding: 'utf8',
      });
      if (result.error || result.status !== 0)
        throw new Error(`プレビューの ${args.slice(0, 2).join(' ')} に失敗しました`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function previewBuildEnvironment(env: Record<string, string | undefined>): {
  account: string;
  token: string;
  subdomain: string;
} {
  if (env.WORKERS_CI !== '1') throw new Error('Workers Builds の外では動かしません');
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const subdomain = env.CLOUDFLARE_PREVIEW_SUBDOMAIN;
  if (!isIsolatedPreviewAccount(account) || !token?.trim())
    throw new Error('Builds には本番と別の Cloudflare アカウントと API トークンが必要です');
  if (!isIsolatedPreviewSubdomain(subdomain)) throw new Error('プレビュー専用の workers.dev サブドメインが必要です');
  if (env.VITE_PREVIEW_WITHOUT_ATTACHMENTS !== '1')
    throw new Error('共有プレビューでは添付 UI を無効にする設定が必要です');
  return { account, token, subdomain };
}

async function main() {
  const { account, token, subdomain } = previewBuildEnvironment(process.env);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (head.status !== 0) throw new Error('コミットの SHA を取れませんでした');
  async function api(route: string, method = 'GET', body?: unknown) {
    const data = (await jsonRequest(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })) as { success?: boolean; result?: unknown };
    if (data?.success !== true) throw new PreviewStepError('Cloudflare API が失敗しました');
    return data.result;
  }
  await deployPreview({
    env: process.env,
    commitSha: head.stdout.trim(),
    listDatabases: async () => {
      const all: PreviewDatabase[] = [];
      for (let page = 1; ; page++) {
        const rows = await api(`?per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error('D1 の一覧を読めませんでした');
        all.push(...rows);
        if (rows.length < 100) return all;
      }
    },
    createDatabase: async (name) => (await api('', 'POST', { name })) as PreviewDatabase,
    deleteDatabase: async (database) => {
      await api(`/${database.uuid}`, 'DELETE');
    },
    openBranches: () => openPreviewBranches(),
    publish: async (input) => {
      publishPreview({ ...input, subdomain });
    },
    log: (message) => console.log(message),
  });
}

if (import.meta.main) {
  main().catch(() => {
    // fetch/子プロセスの例外にトークンが含まれても表示しない。
    console.error('プレビューの処理に失敗しました。Builds の設定と直前の処理を確認してください');
    process.exitCode = 1;
  });
}
