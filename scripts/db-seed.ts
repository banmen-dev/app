// pnpm db:seed: 手元の D1 に全マイグレーションを当て、全部の表の行を消して seed を入れ直す。
// --local だけを使う。seed のトークンは公開された開発用の値なので、本番の D1 には入れない（seed/README.md）
// --persist-to <dir> を渡すと、その場所の D1 に入れる（scripts/migrate-fresh.ts が空の D1 で確かめるのに使う）
// --env-file <file> は Wrangler が使う開発用の値のファイルを指定する。
// --save-sql <file> は --persist-to と一緒に使い、適用済みの seed SQL を再利用できるよう保存する。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { parseDevNow } from '../src/shared/clock.ts';
import { seedSql } from './seed.ts';
import { retryLocalD1 } from './local-d1-retry.ts';

const persistIndex = process.argv.indexOf('--persist-to');
const persistTo = persistIndex === -1 ? undefined : process.argv[persistIndex + 1];
if (persistIndex !== -1 && !persistTo) {
  console.error('--persist-to に場所を渡してください');
  process.exit(1);
}
// 使い捨ての撮影環境などで、作業コピーの開発用の値を読まずに動かすときに使う。
const envFileIndex = process.argv.indexOf('--env-file');
const envFile = envFileIndex === -1 ? undefined : process.argv[envFileIndex + 1];
if (envFileIndex !== -1 && (!envFile || envFile.startsWith('--'))) {
  console.error('--env-file にファイルを指定してください');
  process.exit(1);
}
// 同じ使い捨て D1 に seed を重ねるときは、確かめた SQL を再利用できる。
const saveSqlIndex = process.argv.indexOf('--save-sql');
const saveSql = saveSqlIndex === -1 ? undefined : process.argv[saveSqlIndex + 1];
if (saveSqlIndex !== -1 && (!persistTo || !saveSql || saveSql.startsWith('--'))) {
  console.error('--save-sql には --persist-to と出力先を指定してください');
  process.exit(1);
}
const local = [
  '--local',
  ...(persistTo ? ['--persist-to', persistTo] : []),
  ...(envFile ? ['--env-file', envFile] : []),
];

// --now <ISO 8601、時差付き> を渡すと、その日時を流した日時として日付を埋める（e2e/global-setup.ts が期待値と同じ日時を渡す）。
// 時差の無い値は手元のタイムゾーンで読まれて基準の日がずれるので、DEV_NOW と同じ形だけを受ける
const nowIndex = process.argv.indexOf('--now');
const parsedNow = nowIndex === -1 ? undefined : parseDevNow(process.argv[nowIndex + 1]);
if (parsedNow !== undefined && !parsedNow.ok) {
  console.error('--now に時差付きの ISO 8601 の日時を渡してください（例 2026-11-17T10:00:00+09:00）');
  process.exit(1);
}
const now = parsedNow?.ok ? parsedNow.at : new Date();

async function wrangler(args: string[], capture = false): Promise<string> {
  const result = await retryLocalD1(() =>
    spawnSync('wrangler', ['d1', ...args, ...local], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }),
  );
  if (!capture && result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    console.error(`wrangler d1 ${args[0]} が失敗しました`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

await wrangler(['migrations', 'apply', 'DB']);

const listed = JSON.parse(
  await wrangler(
    ['execute', 'DB', '--json', '--command', "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"],
    true,
  ),
) as { results: { name: string }[] }[];
const tables = listed.flatMap((r) => r.results.map((row) => row.name));

const data = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
const dir = mkdtempSync(path.join(tmpdir(), 'scrum-guild-seed-'));
try {
  const file = path.join(dir, 'seed.sql');
  writeFileSync(file, seedSql(tables, data, Object.values(SEED_SESSIONS), now));
  await wrangler(['execute', 'DB', '--file', file]);
  if (saveSql) copyFileSync(file, saveSql);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('seed を入れました（セッションのトークンは seed/sessions.ts）');
