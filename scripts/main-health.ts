// main の CI を GitHub Issue で追う。依存パッケージを導入せずに動かす。
export const ISSUE_MARKER = '<!-- main-health:v1 -->';
export const LABEL = 'main-broken';
export type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};
type Issue = { number: number; body: string | null; user: { login: string }; pull_request?: unknown };
export type Job = { name: string; conclusion: string | null; html_url: string };
// main への push の CI は開発モードの e2e を飛ばす（ci.yml の e2e-dev）。この検査の失敗は、定期・手動実行の成功でだけ復旧とする。
const E2E_DEV_JOB = /^e2e-dev(?: |$)/;
const RUN_MARKER = /<!-- main-health:run=(\d+):attempt=(\d+) -->/g;
const REQUIRES_MARKER = /<!-- main-health:requires:run=(\d+):attempt=(\d+):e2e-dev=(\d+) -->/g;

/** 失敗した実行の e2e-dev のジョブの数。e2e-dev が失敗していなければ 0（push の CI で確かめられる）。 */
export function requiredE2eDev(jobs: Job[]): number {
  const e2eDev = jobs.filter((job) => E2E_DEV_JOB.test(job.name));
  const failed = e2eDev.filter((job) => !['success', 'skipped'].includes(job.conclusion ?? ''));
  if (!failed.length) return 0;
  return Math.max(failed.length, e2eDev.filter((job) => job.conclusion !== 'skipped').length);
}
export type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export async function reconcile(api: Api, notify = '', log: (message: string) => void = console.log): Promise<void> {
  const latest = async () => {
    const { workflow_runs: runs } = await api<{ workflow_runs: Run[] }>(
      '/actions/workflows/ci.yml/runs?branch=main&per_page=100',
    );
    return runs.find(
      (run) => run.head_branch === 'main' && ['push', 'schedule', 'workflow_dispatch'].includes(run.event),
    );
  };
  const run = await latest();
  if (!run) {
    log('main の CI は未実行です。Actions の起動条件・有効状態を確認してください。');
    return;
  }
  if (run.status !== 'completed') {
    log(`main の CI は実行中または待機中です（run=${run.id}、status=${run.status}）。完了を待ちます。`);
    return;
  }

  const head = await api<{ sha: string }>('/commits/main');
  // 新しい main の検査を待つ。古い成功で閉じたり、古い失敗を新しい障害として通知しない。
  if (run.head_sha !== head.sha) {
    log(
      `古い SHA の CI です（run=${run.id}、CI=${run.head_sha}、main=${head.sha}）。最新 main の CI を手動実行するか、起動条件を確認してください。`,
    );
    return;
  }

  async function pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const items = await api<T[]>(`${path}&per_page=100&page=${page}`);
      all.push(...items);
      if (items.length < 100) return all;
    }
  }
  const issues = (await pages<Issue>('/issues?state=open&labels=main-broken')).filter(
    (issue) => !issue.pull_request && issue.user.login === 'github-actions[bot]' && issue.body?.includes(ISSUE_MARKER),
  );
  const marker = `<!-- main-health:run=${run.id}:attempt=${run.run_attempt} -->`;
  const mentions = notify
    .split(/[\s,]+/)
    .filter((login) => /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login))
    .map((login) => `@${login}`)
    .join(' ');
  const summary = `${marker}\n${mentions}\nコミット: ${run.head_sha}\nCI: ${run.html_url}（試行 ${run.run_attempt}、${run.conclusion}）`;
  const jobsOf = async (path: string) => {
    const jobs: Job[] = [];
    for (let page = 1; ; page++) {
      const result = await api<{ jobs: Job[] }>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) return jobs;
    }
  };
  // 判定と追記の重複確認で同じ一覧を使うので、Issue ごとに1回だけ引く。
  const commentCache = new Map<number, Promise<{ body: string }[]>>();
  const botComments = (issue: Issue) => {
    let comments = commentCache.get(issue.number);
    if (!comments) {
      comments = pages<{ body: string; user: { login: string } }>(
        `/issues/${issue.number}/comments?direction=asc`,
      ).then((all) => all.filter((comment) => comment.user.login === 'github-actions[bot]'));
      commentCache.set(issue.number, comments);
    }
    return comments;
  };
  // 障害 Issue の記録（本文と bot の追記）から、復旧に要る e2e-dev のジョブの数を求める。
  // 印の無い記録（この判定を足す前の Issue）は、残した実行の ID と試行からジョブを引く。引けなければ undefined。
  const requiredFor = async (issue: Issue): Promise<number | undefined> => {
    const records = [issue.body ?? '', ...(await botComments(issue)).map((comment) => comment.body)].join('\n');
    const known = new Map<string, number>();
    // 同じ実行の印が重なっても、後の印で数を減らさない。
    for (const [, id, attempt, count] of records.matchAll(REQUIRES_MARKER))
      known.set(`${id}:${attempt}`, Math.max(known.get(`${id}:${attempt}`) ?? 0, Number(count)));
    let required = Math.max(0, ...known.values());
    for (const [, id, attempt] of records.matchAll(RUN_MARKER)) {
      if (known.has(`${id}:${attempt}`)) continue;
      try {
        const jobs = await jobsOf(`/actions/runs/${id}/attempts/${attempt}/jobs`);
        if (!jobs.length) throw new Error('ジョブが0件');
        const count = requiredE2eDev(jobs);
        known.set(`${id}:${attempt}`, count);
        required = Math.max(required, count);
      } catch (error) {
        log(
          `#${issue.number} の記録（run=${id}、試行 ${attempt}）の検査範囲を取得できません（${String(error)}）。復旧扱いにしません。`,
        );
        return undefined;
      }
    }
    return required;
  };
  const commentOnce = async (issue: Issue, body: string) => {
    if (issue.body?.includes(marker)) return;
    if ((await botComments(issue)).some((comment) => comment.body.includes(marker))) return;
    await api(`/issues/${issue.number}/comments`, 'POST', { body });
  };

  if (run.conclusion === 'success') {
    if (!issues.length) {
      log('最新 main の CI は成功済みで、開いている復旧 Issue はありません。');
      return;
    }
    // 障害 Issue に残る e2e-dev の失敗は、この実行で e2e-dev が記録の数以上走って全部成功したときだけ復旧とする。
    const recovered: Issue[] = [];
    let latestJobs: Promise<Job[]> | undefined;
    for (const issue of issues) {
      const required = await requiredFor(issue);
      if (required === undefined) continue;
      if (required > 0) {
        let jobs: Job[];
        try {
          jobs = await (latestJobs ??= jobsOf(`/actions/runs/${run.id}/jobs?filter=latest`));
        } catch (error) {
          log(
            `#${issue.number}: 最新 main の CI（run=${run.id}）のジョブを取得できません（${String(error)}）。復旧扱いにしません。`,
          );
          continue;
        }
        const e2eDev = jobs.filter((job) => E2E_DEV_JOB.test(job.name));
        if (e2eDev.length < required || e2eDev.some((job) => job.conclusion !== 'success')) {
          log(
            `#${issue.number} は e2e-dev（${required} シャード）の失敗が未復旧です。最新 main の CI（run=${run.id}、${run.event}）では e2e-dev の成功が ${e2eDev.filter((job) => job.conclusion === 'success').length} 件です。定期実行か手動実行の ci の成功を待ちます。`,
          );
          continue;
        }
      }
      recovered.push(issue);
    }
    if (!recovered.length) return;
    // API の読み取り中に push や再実行があれば、次の監視に任せる。
    const current = await latest();
    const currentHead = await api<{ sha: string }>('/commits/main');
    if (
      current?.id !== run.id ||
      current.run_attempt !== run.run_attempt ||
      current.status !== 'completed' ||
      current.conclusion !== 'success' ||
      currentHead.sha !== run.head_sha
    ) {
      log('再確認中に main または CI の結果が変わりました。次の監視で確認します。');
      return;
    }
    for (const issue of recovered) {
      // 成功した実行の印も残す。閉じる操作が失敗して次の監視で読み直すとき、印の無い記録としてジョブを引かない。
      await commentOnce(
        issue,
        `最新の main の CI が成功しました。通常の作業を再開できます。\n\n${summary}\n<!-- main-health:requires:run=${run.id}:attempt=${run.run_attempt}:e2e-dev=0 -->`,
      );
      await api(`/issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    }
    return;
  }

  // 失敗だけでなくキャンセル・タイムアウト等も、正常を確認できない状態として追う。
  const jobs = await jobsOf(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`);
  const requires = `<!-- main-health:requires:run=${run.id}:attempt=${run.run_attempt}:e2e-dev=${requiredE2eDev(jobs)} -->`;
  const failed = jobs.filter((job) => !['success', 'skipped'].includes(job.conclusion ?? ''));
  const body = `main の正常を確認できません。復旧を最優先にしてください。\n\n${summary}\n${requires}\n\n${failed.map((job) => `- [${job.name.replace(/[[\]<>]/g, '')}](${job.html_url}): ${job.conclusion ?? '未完了'}`).join('\n')}\n\n復旧手順: docs/development.md の「main の障害通知と復旧」を参照。`;
  if (issues.length) {
    await commentOnce(issues[0], body);
  } else {
    // ラベルが無ければ作る。既存ラベルの変更はしない。
    const labels = await pages<{ name: string }>('/labels?');
    if (!labels.some((label) => label.name === LABEL))
      await api('/labels', 'POST', { name: LABEL, color: 'b60205', description: '最優先: main の CI を復旧する' });
    await api('/issues', 'POST', {
      title: '[main障害] CI を復旧する（最優先）',
      labels: [LABEL],
      body: `${ISSUE_MARKER}\n${body}`,
    });
  }
}

if (import.meta.main) {
  const repo = process.env.REPO;
  const token = process.env.GH_TOKEN;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error('REPO と GH_TOKEN が必要です');
  const api: Api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path}: ${response.status}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  await reconcile(api, process.env.MAIN_CI_NOTIFY);
}
