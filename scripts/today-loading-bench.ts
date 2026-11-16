// pnpm exec node scripts/today-loading-bench.ts [--runs 20] [--port 9742]
// [--fixture-at ISO日時] [--reverse-modes]。#1055 の A/B/C 比較専用。使い捨て D1 だけを使う。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { operations } from '../src/shared/operations/index.ts';
import { isOutsideOperation } from '../src/shared/operations/define.ts';
import { loadingFixtureSql } from './loading-fixture.ts';
import type { Reading } from './loading-screens.ts';
import { percentile } from './loading-stats.ts';
import { sessionInserts } from './seed.ts';
import { todayTrial, type TodayMode } from './today-loading-trial.ts';

function option(name: string, fallback: number, max: number): number {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`${name} が範囲外です`);
  return value;
}
const runs = option('--runs', 20, 10000);
const port = option('--port', 9742, 65534);
const fixtureIndex = process.argv.indexOf('--fixture-at');
const fixtureTime = fixtureIndex < 0 ? new Date() : new Date(process.argv[fixtureIndex + 1] ?? '');
if (!Number.isFinite(fixtureTime.getTime())) throw new Error('--fixture-at が不正です');
const origin = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'scrum-guild-loading-'));
// 秘密の設定ファイルを探索しないよう、一時ディレクトリに独立した wrangler 設定を作る。
const root = process.cwd();
const config = path.join(dir, 'wrangler.json');
const version = `loading-bench-${randomUUID()}`;
writeFileSync(
  config,
  JSON.stringify({
    name: 'loading-bench',
    main: path.join(root, 'src/server/index.ts'),
    compatibility_date: '2026-10-01',
    send_metrics: false,
    vars: {
      PUBLIC_ORIGIN: origin,
      APP_VERSION: version,
      OPERATOR_LOGIN_IDS: SEED_OPERATOR_LOGIN_ID,
      CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ 1: Buffer.alloc(32).toString('base64') }),
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'loading-bench',
        database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: path.join(root, 'migrations'),
      },
    ],
    r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'loading-bench' }],
  }),
);
let server: ReturnType<typeof spawn> | undefined;
let tracked: ReturnType<typeof trackServer> | undefined;
let interrupted = false;
const stop = () => {
  interrupted = true;
  tracked?.interrupt();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);
function command(args: string[]) {
  if (interrupted) throw new Error('計測を中断しました');
  const result = spawnSync('wrangler', [...args, '--config', config, '--local', '--persist-to', dir], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0)
    throw new Error(`wrangler ${args.slice(0, 2).join(' ')} が失敗しました: ${result.stderr}`);
  return result.stdout;
}
async function call(reading: Reading, role: 'admin' | 'member') {
  if (interrupted) throw new Error('計測を中断しました');
  const definition = operations.find((op) => op.name === reading.name);
  if (
    !definition ||
    definition.mode !== 'read' ||
    isOutsideOperation(definition) !== reading.global ||
    !definition.input.safeParse(reading.input).success
  )
    throw new Error(`${reading.name}: 計測表の操作または入力が不正`);
  const started = performance.now();
  const response = await fetch(`${origin}/api/${reading.global ? '' : 'aoba/'}${reading.name}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: `${sessionCookieName(origin)}=${SEED_SESSIONS[role].token}`,
    },
    body: JSON.stringify(reading.input),
    signal: AbortSignal.timeout(30000),
  });
  const body: unknown = await response.json();
  const ms = performance.now() - started;
  return {
    ms,
    finishedAt: started + ms,
    secondary: reading.secondary,
    body,
    validate: (body: unknown) => {
      if (!response.ok || !definition.output.safeParse(body).success)
        throw new Error(`${reading.name}: HTTP ${response.status} または応答の形が不正`);
    },
  };
}
try {
  console.log(`使い捨て D1: ${dir}（終了時に削除）`);
  command(['d1', 'migrations', 'apply', 'DB']);
  // 空の D1 なので既存行の削除は不要。seed の固定行と期限付きセッションを入れる。
  const file = path.join(dir, 'fixture.sql');
  writeFileSync(
    file,
    readFileSync(path.join(root, 'seed/data.sql'), 'utf8') +
      sessionInserts(Object.values(SEED_SESSIONS), new Date()) +
      loadingFixtureSql(fixtureTime),
  );
  command(['d1', 'execute', 'DB', '--file', file]);
  server = spawn(
    'wrangler',
    [
      'dev',
      '--config',
      config,
      '--local',
      '--persist-to',
      dir,
      '--port',
      String(port),
      '--inspector-port',
      String(port + 1),
    ],
    { stdio: 'ignore', cwd: dir, detached: process.platform !== 'win32' },
  );
  tracked = trackServer(server, process.platform !== 'win32');
  for (let i = 0; ; i++) {
    if (interrupted || tracked.stopped || i >= 120) throw new Error('計測サーバーが立ち上がりません');
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok && isBenchHealth(await res.json(), version)) break;
    } catch {
      /* 起動を待つ */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`Node ${process.version}、温め2回 + ${runs}回。分位点 nearest-rank。単位 ms。`);
  console.log(`fixture 基準時刻: ${fixtureTime.toISOString()}`);
  console.log('| 条件 | 発行順 | 方式 | 主 p50/p95 | load相当 p50/p95 | 全応答 p50/p95 | 同一試行の追加待ち p50/p95 |');
  console.log('| --- | --- | --- | ---: | ---: | ---: | ---: |');
  // 管理者は leader 分岐。一般メンバーの空応答と利用開始時は別条件にする。
  for (const scenario of ['leader-empty', 'member-empty', 'member-visible'] as const) {
    const role = scenario === 'leader-empty' ? 'admin' : 'member';
    if (scenario === 'member-visible') {
      const scenarioFile = path.join(dir, 'member-visible.sql');
      // ハルカの起票履歴だけを移す。担当・今日の印・件数を保ち、必須手順を未完にする。
      writeFileSync(
        scenarioFile,
        `UPDATE tasks SET created_by='019a0000-0000-7000-8000-000000000301'
        WHERE created_by='019a0000-0000-7000-8000-000000000302'
        AND workspace_id IN (SELECT id FROM workspaces WHERE organization_id='019a0000-0000-7000-8000-000000000201');`,
      );
      command(['d1', 'execute', 'DB', '--file', scenarioFile]);
    }
    const readings: Reading[] = [
      { name: 'today', secondary: false, input: {}, global: false },
      { name: 'first-steps', secondary: true, input: {}, global: false },
    ];
    // 条件を計測前に検証。計測ループ内の検証は全応答完了後に行う。
    const preflight = await call(readings[1]!, role);
    preflight.validate(preflight.body);
    const steps = preflight.body as { role: string | null; steps: unknown[] };
    if (
      scenario === 'member-visible'
        ? steps.role !== 'member' || !steps.steps.length
        : steps.role !== null || steps.steps.length !== 0
    )
      throw new Error(`${scenario}: 手順の状態が想定外`);
    const modes: TodayMode[] = process.argv.includes('--reverse-modes') ? ['C', 'B', 'A'] : ['A', 'B', 'C'];
    for (const reverse of [false, true]) {
      for (const mode of modes) {
        const read = () => todayTrial(mode, reverse, (secondary) => call(readings[secondary ? 1 : 0]!, role));
        await read();
        await read();
        const samples: Awaited<ReturnType<typeof todayTrial>>[] = [];
        for (let i = 0; i < runs; i++) samples.push(await read());
        const pair = (key: keyof (typeof samples)[number]) =>
          [0.5, 0.95]
            .map((p) =>
              percentile(
                samples.map((s) => s[key]),
                p,
              ).toFixed(2),
            )
            .join(' / ');
        console.log(
          `| ${scenario} | ${reverse ? '逆順' : '正順'} | ${mode} | ${pair('primary')} | ${pair('ready')} | ${pair('total')} | ${pair('wait')} |`,
        );
      }
    }
  }
} finally {
  await tracked?.stop();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  process.off('SIGHUP', stop);
  rmSync(dir, { recursive: true, force: true });
  console.log(`削除済み: ${dir}`);
}
