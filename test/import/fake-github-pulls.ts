// #1312 のテスト用 GitHub。検索の上限や存在しない since の絞り込みを偽で補わない。
import { fakeIssue, fakePat } from './fake-github-pat.ts';

export const PULL_PAT = fakePat('OwnPulls');
export const PULL_SCOPE = { id: '1001', name: 'guild-fake/alpha' };
export const PULL_LOGIN = 'fake-ranger';

// 本物の GitHub の作者・担当者には不変の id がある。login だけを指定した旧 fixture も同じ形にする。
// id の明示指定は undefined や不正値も保持し、異常応答の検査を弱めない。
function withUserId<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || 'id' in value) return value;
  if (!('login' in value) || typeof value.login !== 'string') return value;
  return { ...value, id: value.login.toLowerCase() === PULL_LOGIN ? 42 : 99 };
}

export function fakePull(n: number, patch: Record<string, unknown> = {}) {
  const pull = {
    ...fakeIssue(PULL_SCOPE.name, n, { id: 800_000 + n, assignees: [] }),
    user: { id: 42, login: PULL_LOGIN },
    html_url: `https://github.com/${PULL_SCOPE.name}/pull/${n}`,
    created_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    base: { repo: { id: 1001, full_name: PULL_SCOPE.name } },
    ...patch,
  };
  return {
    ...pull,
    user: withUserId(pull.user),
    assignee: withUserId(pull.assignee),
    assignees: Array.isArray(pull.assignees) ? pull.assignees.map(withUserId) : pull.assignees,
  };
}

export function ownPullFixture() {
  const calls: Request[] = [];
  const data = {
    issues: [] as Record<string, unknown>[],
    pulls: [] as Record<string, unknown>[],
    loose: false,
    pullFailure: 0,
    pullBody: undefined as unknown,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.github.com') throw new Error('想定外のホスト');
    if (url.pathname === '/user') return Response.json({ type: 'User', id: 42, login: PULL_LOGIN });
    const match = /^\/repositories\/(\d+)\/(issues|pulls)$/.exec(url.pathname);
    if (!match || match[1] !== PULL_SCOPE.id) return Response.json({ message: 'Not found' }, { status: 404 });
    const pulls = match[2] === 'pulls';
    if (pulls && data.pullFailure) {
      return new Response(`SECRET ${PULL_PAT}`, { status: data.pullFailure });
    }
    if (pulls && data.pullBody !== undefined) return Response.json(data.pullBody);
    let list = [...(pulls ? data.pulls : data.issues)];
    if (!data.loose) {
      const state = url.searchParams.get('state') ?? 'open';
      const assignee = url.searchParams.get('assignee');
      const since = pulls ? null : url.searchParams.get('since');
      list = list.filter((item) => {
        if (state !== 'all' && item.state !== state) return false;
        const assignees = (item.assignees ?? []) as { login: string }[];
        if (assignee !== null && !assignees.some((a) => a.login.toLowerCase() === assignee.toLowerCase())) return false;
        return since === null || Date.parse(String(item.updated_at)) > Date.parse(since);
      });
    }
    const field = url.searchParams.get('sort') === 'created' ? 'created_at' : 'updated_at';
    const sign = url.searchParams.get('direction') === 'asc' ? 1 : -1;
    list.sort((a, b) => sign * (Date.parse(String(a[field])) - Date.parse(String(b[field]))));
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
    const page = Number(url.searchParams.get('page') ?? 1);
    return Response.json(list.slice((page - 1) * perPage, page * perPage));
  };
  return { data, calls, fetcher };
}
