import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { reconcile, requiredE2eDev, ISSUE_MARKER, type Api, type Run } from './main-health.ts';

type Job = { name: string; conclusion: string | null; html_url: string };
const job = (name: string, conclusion: string | null): Job => ({
  name,
  conclusion,
  html_url: `https://github.com/example/app/actions/jobs/${encodeURIComponent(name)}`,
});
const shards = (conclusion: string | null, failedShard?: number) =>
  [1, 2, 3, 4, 5].map((shard) => job(`e2e-dev (${shard})`, shard === failedShard ? 'failure' : conclusion));
// push の CI は e2e-dev を飛ばす。定期・手動実行は5シャードを走らせる
const pushJobs = (conclusion = 'success') => [job('test', conclusion), job('e2e (1)', 'success'), ...shards('skipped')];
const fullJobs = (failedShard?: number) => [
  job('test', 'success'),
  job('e2e (1)', 'success'),
  ...shards('success', failedShard),
];

const run: Run = {
  id: 10,
  run_attempt: 1,
  head_sha: 'abc',
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/example/app/actions/runs/10',
};
function fixture() {
  const state = {
    runs: [{ ...run }],
    sha: 'abc',
    issues: [] as { number: number; body: string; user: { login: string }; pull_request?: unknown }[],
    comments: [] as { body: string; user: { login: string } }[],
    writes: [] as { path: string; method: string; body: Record<string, unknown> }[],
    jobs: {} as Record<number, Job[]>,
    jobErrors: new Set<number>(),
    reads: [] as string[],
  };
  const api: Api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (method !== 'GET') {
      state.writes.push({ path, method, body: body as Record<string, unknown> });
      if (path === '/issues')
        state.issues.push({ number: 1, body: (body as { body: string }).body, user: { login: 'github-actions[bot]' } });
      if (path.endsWith('/comments'))
        state.comments.push({ body: (body as { body: string }).body, user: { login: 'github-actions[bot]' } });
      return {} as T;
    }
    if (path.startsWith('/actions/workflows/')) return { workflow_runs: state.runs } as T;
    if (path === '/commits/main') return { sha: state.sha } as T;
    if (path.startsWith('/actions/runs/')) {
      state.reads.push(path);
      const id = Number(path.split('/')[3]);
      if (state.jobErrors.has(id)) throw new Error(`GitHub API GET ${path}: 404`);
      return {
        jobs: state.jobs[id] ?? [
          { name: 'e2e (1)', conclusion: 'failure', html_url: 'https://github.com/example/app/actions/runs/10/job/1' },
        ],
      } as T;
    }
    if (path.endsWith('/comments?direction=asc&per_page=100&page=1')) return state.comments as T;
    if (path.startsWith('/issues?')) return state.issues as T;
    if (path.startsWith('/labels?')) return [{ name: 'main-broken' }] as T;
    throw new Error(`Unexpected API: ${path}`);
  };
  return { state, api };
}

test('失敗で最優先の Issue を作り、ログ・SHA・指定した通知先を含める。繰り返しの監視は重複しない', async () => {
  const { state, api } = fixture();
  await reconcile(api, 'aoba,kaede');
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].body.labels, ['main-broken']);
  assert.match(state.issues[0].body, /@aoba @kaede/);
  assert.match(state.issues[0].body, /e2e \(1\)/);
  assert.match(state.issues[0].body, /コミット: abc/);
  await reconcile(api);
  assert.equal(state.writes.length, 1);
});

test('次の失敗と再実行の失敗は既存 Issue に各1回追記する', async () => {
  const { state, api } = fixture();
  await reconcile(api);
  state.runs[0].id++;
  await reconcile(api);
  await reconcile(api);
  assert.equal(state.comments.length, 1);
  state.runs[0].run_attempt++;
  await reconcile(api);
  assert.equal(state.comments.length, 2);
  assert.equal(state.writes.filter((write) => write.path === '/issues').length, 1);
});

test('最新 main の成功だけで復旧コメントとクローズを行う', async () => {
  const { state, api } = fixture();
  await reconcile(api);
  state.runs[0] = { ...run, id: 11, conclusion: 'success' };
  await reconcile(api);
  assert.match(state.comments[0].body, /最新の main の CI が成功/);
  assert.deepEqual(state.writes.at(-1)?.body, { state: 'closed', state_reason: 'completed' });
});

for (const scenario of ['古い SHA', '実行中', '未実行', 'PR']) {
  test(`${scenario} では Issue を作成・クローズしない`, async () => {
    const { state, api } = fixture();
    if (scenario === '古い SHA') state.sha = 'def';
    if (scenario === '実行中') state.runs[0].status = 'in_progress';
    if (scenario === '未実行') state.runs = [];
    if (scenario === 'PR') state.runs[0].event = 'pull_request';
    await reconcile(api);
    assert.equal(state.writes.length, 0);
  });
}

test('成功の二重確認中に push があれば閉じない', async () => {
  const { state, api } = fixture();
  await reconcile(api);
  state.runs[0] = { ...run, id: 11, conclusion: 'success' };
  let reads = 0;
  const racingApi: Api = async <T>(path: string, method?: string, body?: unknown) => {
    if (path === '/commits/main' && ++reads === 2) state.sha = 'new';
    return api<T>(path, method, body);
  };
  await reconcile(racingApi);
  assert.equal(state.writes.length, 1);
});

test('キャンセルを成功とみなさず通知する', async () => {
  const { state, api } = fixture();
  state.runs[0].conclusion = 'cancelled';
  await reconcile(api);
  assert.match(state.issues[0].body, /cancelled/);
});

test('人の本文に同じ印があっても変更しない', async () => {
  const { state, api } = fixture();
  state.issues.push({ number: 50, body: ISSUE_MARKER, user: { login: 'aoba' } });
  await reconcile(api);
  assert.equal(state.writes[0].path, '/issues');
});

test('PR の実行名は label.yml が完全一致で参照する既存形式を維持する', () => {
  const ci = load(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(
    ci['run-name'],
    'ci pr=${{ github.event.pull_request.number }} base=${{ github.event.pull_request.base.ref }}',
  );
});

test('main の CI と通知の起動条件・権限を保つ', () => {
  const read = (name: string) =>
    load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as Record<string, unknown>;
  const ci = read('ci') as {
    on: Record<string, unknown>;
    jobs: {
      changes: { outputs: Record<string, string>; steps: { id?: string; if?: string; run?: string }[] };
      'worktree-pnpm': { needs?: string[]; if?: string; steps: { if?: string; run?: string }[] };
      check: { needs: string };
      'ci-ok': { needs: string[] };
    };
    permissions: unknown;
  };
  assert.deepEqual(ci.on.push, { branches: ['main'] });
  assert.ok(ci.on.schedule);
  const main = ci.jobs.changes.steps.find((step) => step.id === 'main');
  assert.equal(main?.if, "github.event_name != 'pull_request'");
  for (const output of ['docs_only=false', 'dev_build=true', 'repeat=false']) assert.ok(main?.run?.includes(output));
  for (const id of ['docs', 'repeat'])
    assert.equal(ci.jobs.changes.steps.find((step) => step.id === id)?.if, "github.event_name == 'pull_request'");
  const guard = ci.jobs['worktree-pnpm'];
  assert.equal(guard.if, undefined);
  assert.equal(guard.needs, undefined);
  assert.equal(ci.jobs.check.needs, 'changes');
  const pnpmCheck = guard.steps.find((step) => step.run === 'node scripts/check-worktree-pnpm.ts');
  assert.ok(pnpmCheck);
  assert.equal(pnpmCheck.if, undefined);
  assert.ok(ci.jobs['ci-ok'].needs.includes('changes'));
  assert.ok(ci.jobs['ci-ok'].needs.includes('worktree-pnpm'));
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const monitor = read('main-health') as { on: Record<string, unknown>; permissions: unknown };
  assert.deepEqual(monitor.on.workflow_run, { workflows: ['ci'], branches: ['main'], types: ['completed'] });
  assert.deepEqual(monitor.permissions, { contents: 'read', actions: 'read', issues: 'write' });
});

for (const scenario of ['未実行', '実行中', '古い SHA']) {
  test(`${scenario} で待機する理由をログに出す`, async () => {
    const { state, api } = fixture();
    if (scenario === '未実行') state.runs = [];
    if (scenario === '実行中') state.runs[0].status = 'in_progress';
    if (scenario === '古い SHA') state.sha = 'new';
    const logs: string[] = [];
    await reconcile(api, '', (message) => logs.push(message));
    assert.equal(state.writes.length, 0);
    assert.ok(logs.some((message) => message.includes(scenario)));
  });
}

test('失敗した e2e-dev のジョブの数を、e2e-dev が失敗したときだけ数える', () => {
  assert.equal(requiredE2eDev(fullJobs(3)), 5);
  assert.equal(requiredE2eDev([job('test', 'failure'), ...shards('success')]), 0);
  assert.equal(requiredE2eDev(pushJobs('failure')), 0);
  // 失敗したジョブだけを再実行した試行でも、1つ以上を求める
  assert.equal(requiredE2eDev([job('e2e-dev (2)', 'cancelled')]), 1);
  assert.equal(requiredE2eDev([job('e2e-dev-extra', 'failure')]), 0);
});

// 定期実行の e2e-dev が落ちて Issue が開いた状態を作る
async function e2eDevFailure() {
  const fx = fixture();
  fx.state.runs[0] = { ...run, event: 'schedule' };
  fx.state.jobs[10] = fullJobs(3);
  await reconcile(fx.api);
  assert.match(fx.state.issues[0].body, /<!-- main-health:requires:run=10:attempt=1:e2e-dev=5 -->/);
  return fx;
}
const closes = (writes: { body: Record<string, unknown> }[]) =>
  writes.filter((write) => write.body?.state === 'closed').length;

test('定期実行の e2e-dev の失敗は、別の最新 SHA の push の CI が成功しても閉じない', async () => {
  const { state, api } = await e2eDevFailure();
  state.sha = 'def';
  state.runs[0] = { ...run, id: 11, head_sha: 'def', conclusion: 'success' };
  state.jobs[11] = pushJobs();
  const logs: string[] = [];
  await reconcile(api, '', (message) => logs.push(message));
  assert.equal(state.writes.length, 1);
  assert.equal(state.comments.length, 0);
  assert.ok(logs.some((message) => message.includes('e2e-dev') && message.includes('定期実行か手動実行')));
});

for (const event of ['schedule', 'workflow_dispatch']) {
  test(`最新 main の ${event} の CI で e2e-dev の5シャードが成功したら、一度だけ通知して閉じる`, async () => {
    const { state, api } = await e2eDevFailure();
    state.sha = 'def';
    state.runs[0] = { ...run, id: 12, head_sha: 'def', event, conclusion: 'success' };
    state.jobs[12] = fullJobs();
    await reconcile(api);
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0].body, /最新の main の CI が成功/);
    assert.equal(closes(state.writes), 1);
    assert.ok(state.reads.includes('/actions/runs/12/jobs?filter=latest&per_page=100&page=1'));
    // 閉じた後の監視では、何も書かない
    state.issues.length = 0;
    await reconcile(api);
    assert.equal(state.comments.length, 1);
    assert.equal(closes(state.writes), 1);
  });
}

for (const [scenario, jobs] of [
  ['シャードが足りない', [job('test', 'success'), ...shards('success').slice(0, 4)]],
  ['シャードが飛ばされた', [job('test', 'success'), ...shards('success').slice(0, 4), job('e2e-dev (5)', 'skipped')]],
] as const) {
  test(`e2e-dev の${scenario}成功では閉じない`, async () => {
    const { state, api } = await e2eDevFailure();
    state.runs[0] = { ...run, id: 12, event: 'workflow_dispatch', conclusion: 'success' };
    state.jobs[12] = [...jobs];
    await reconcile(api);
    assert.equal(closes(state.writes), 0);
  });
}

test('e2e-dev の未復旧の後に push の CI が落ちても、追記の後の push の成功では閉じない', async () => {
  const { state, api } = await e2eDevFailure();
  state.runs[0] = { ...run, id: 11, conclusion: 'failure' };
  state.jobs[11] = pushJobs('failure');
  await reconcile(api);
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /e2e-dev=0 -->/);
  state.runs[0] = { ...run, id: 13, conclusion: 'success' };
  state.jobs[13] = pushJobs();
  await reconcile(api);
  assert.equal(closes(state.writes), 0);
});

test('push の CI だけで検査できる障害は、最新 main の push の CI の成功で閉じる', async () => {
  const { state, api } = fixture();
  state.jobs[10] = pushJobs('failure');
  await reconcile(api);
  assert.match(state.issues[0].body, /e2e-dev=0 -->/);
  state.sha = 'def';
  state.runs[0] = { ...run, id: 11, head_sha: 'def', conclusion: 'success' };
  state.jobs[11] = pushJobs();
  await reconcile(api);
  assert.equal(closes(state.writes), 1);
  // e2e-dev が要らないときは、成功した実行のジョブを引かない
  assert.ok(!state.reads.some((path) => path.startsWith('/actions/runs/11/')));
});

function legacyIssue(state: ReturnType<typeof fixture>['state']) {
  // 検査範囲の印を残す前の形式の Issue
  state.issues.push({
    number: 7,
    body: `${ISSUE_MARKER}\nmain の正常を確認できません。\n\n<!-- main-health:run=9:attempt=2 -->\nコミット: old`,
    user: { login: 'github-actions[bot]' },
  });
  state.runs[0] = { ...run, id: 11, conclusion: 'success' };
  state.jobs[11] = pushJobs();
}

test('印の無い既存の Issue は、残した実行の ID と試行からジョブを引いて判定する', async () => {
  const { state, api } = fixture();
  legacyIssue(state);
  state.jobs[9] = fullJobs(1);
  await reconcile(api);
  assert.ok(state.reads.includes('/actions/runs/9/attempts/2/jobs?per_page=100&page=1'));
  assert.equal(closes(state.writes), 0);
  state.runs[0] = { ...run, id: 12, event: 'schedule', conclusion: 'success' };
  state.jobs[12] = fullJobs();
  await reconcile(api);
  assert.equal(closes(state.writes), 1);
});

test('印の無い既存の Issue で push の CI だけの失敗なら、push の成功で閉じる', async () => {
  const { state, api } = fixture();
  legacyIssue(state);
  state.jobs[9] = pushJobs('failure');
  await reconcile(api);
  assert.equal(closes(state.writes), 1);
});

test('記録した実行のジョブを取得できなければ、閉じずに理由をログに出す', async () => {
  const { state, api } = fixture();
  legacyIssue(state);
  state.jobErrors.add(9);
  const logs: string[] = [];
  await reconcile(api, '', (message) => logs.push(message));
  assert.equal(state.writes.length, 0);
  assert.ok(logs.some((message) => message.includes('run=9') && message.includes('復旧扱いにしません')));
});

test('最新 main の CI のジョブを取得できなければ閉じない', async () => {
  const { state, api } = await e2eDevFailure();
  state.runs[0] = { ...run, id: 12, event: 'schedule', conclusion: 'success' };
  state.jobErrors.add(12);
  const logs: string[] = [];
  await reconcile(api, '', (message) => logs.push(message));
  assert.equal(closes(state.writes), 0);
  assert.ok(logs.some((message) => message.includes('run=12') && message.includes('復旧扱いにしません')));
});

test('人のコメントの検査範囲の印は数えない', async () => {
  const { state, api } = await e2eDevFailure();
  state.comments.push({ body: '<!-- main-health:requires:run=10:attempt=1:e2e-dev=0 -->', user: { login: 'aoba' } });
  state.runs[0] = { ...run, id: 11, conclusion: 'success' };
  state.jobs[11] = pushJobs();
  await reconcile(api);
  assert.equal(closes(state.writes), 0);
});

for (const scenario of ['古い SHA', '実行中']) {
  test(`e2e-dev の未復旧で、${scenario}の定期実行では閉じない`, async () => {
    const { state, api } = await e2eDevFailure();
    state.runs[0] = { ...run, id: 12, event: 'schedule', conclusion: 'success' };
    state.jobs[12] = fullJobs();
    if (scenario === '古い SHA') state.sha = 'new';
    if (scenario === '実行中') Object.assign(state.runs[0], { status: 'in_progress', conclusion: null });
    await reconcile(api);
    assert.equal(state.writes.length, 1);
  });
}

test('e2e-dev の復旧の判定中に main が進めば閉じない', async () => {
  const { state, api } = await e2eDevFailure();
  state.runs[0] = { ...run, id: 12, event: 'schedule', conclusion: 'success' };
  state.jobs[12] = fullJobs();
  const racingApi: Api = async <T>(path: string, method?: string, body?: unknown) => {
    if (path.startsWith('/actions/runs/12/')) state.sha = 'new';
    return api<T>(path, method, body);
  };
  await reconcile(racingApi);
  assert.equal(closes(state.writes), 0);
});
