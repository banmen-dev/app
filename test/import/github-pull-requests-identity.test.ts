// login は改名後に第三者が取得できる。GitHub が返す不変の user.id で PAT の本人を照合する。
import { describe, expect, test } from 'vitest';
import { importSourceOf, ImportSourceError, type ImportItem } from '../../src/server/import/index.ts';
import { fakeIssue } from './fake-github-pat.ts';
import { fakePull, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

const source = importSourceOf('github');
const OLD_PULL_CURSOR = 'v1:pulls:old-login:2';
const OLD_ISSUE_CURSOR = 'old-login:1:2026-01-01T00:00:00.000Z';

function fixture() {
  const calls: Request[] = [];
  const data = {
    owner: { type: 'User', id: 42, login: 'new-login' } as Record<string, unknown>,
    userFailure: 0,
    issues: [] as Record<string, unknown>[],
    pulls: Array.from({ length: 100 }, (_, i) =>
      fakePull(i + 1, { user: { id: 77, login: 'fake-unrelated' } }),
    ) as Record<string, unknown>[],
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.github.com') throw new Error('想定外のホスト');
    if (url.pathname === '/user') {
      if (data.userFailure) return new Response(`SECRET ${PULL_PAT}`, { status: data.userFailure });
      return Response.json(data.owner);
    }
    if (url.pathname !== '/repositories/1001/issues' && url.pathname !== '/repositories/1001/pulls') {
      throw new Error('想定外の要求');
    }
    const pulls = url.pathname.endsWith('/pulls');
    let list = [...(pulls ? data.pulls : data.issues)];
    const state = url.searchParams.get('state') ?? 'open';
    const assignee = url.searchParams.get('assignee');
    const since = pulls ? null : url.searchParams.get('since');
    list = list.filter((item) => {
      if (state !== 'all' && item.state !== state) return false;
      const assignees = (item.assignees ?? []) as { id: number; login: string }[];
      if (assignee && !assignees.some((a) => a.login.toLowerCase() === assignee.toLowerCase())) return false;
      return since === null || Date.parse(String(item.updated_at)) > Date.parse(since);
    });
    const field = url.searchParams.get('sort') === 'created' ? 'created_at' : 'updated_at';
    const sign = url.searchParams.get('direction') === 'asc' ? 1 : -1;
    list.sort((a, b) => sign * (Date.parse(String(a[field])) - Date.parse(String(b[field]))));
    const page = Number(url.searchParams.get('page') ?? 1);
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
    return Response.json(list.slice((page - 1) * perPage, page * perPage));
  };
  async function page(cursor: string | null) {
    const before = calls.length;
    const result = await source.fetchPage({ credential: PULL_PAT, fetcher, scope: PULL_SCOPE, settings: {}, cursor });
    expect(calls.length - before).toBeLessThanOrEqual(cursor === null ? 2 : 1);
    expect(result.items.length).toBeLessThanOrEqual(100);
    if (result.next !== null) expect(result.next.length).toBeLessThanOrEqual(2000);
    return result;
  }
  async function drain(cursor: string | null = OLD_PULL_CURSOR) {
    const items: ImportItem[] = [];
    const seen = new Set<string>();
    for (let step = 0; step < 20; step++) {
      const result = await page(cursor);
      items.push(...result.items);
      if (result.next === null) return items;
      expect(seen.has(result.next)).toBe(false);
      seen.add(result.next);
      cursor = result.next;
    }
    throw new Error('本人確認の移行と取得が20回以内に終わらない');
  }
  return { calls, data, page, drain };
}

describe('PAT 本人の改名と login の再利用', () => {
  test('旧 PR カーソルの login を別 ID の作者が再取得しても第三者 PR は取り込まない', async () => {
    const f = fixture();
    f.data.pulls.push(fakePull(101, { user: { id: 99, login: 'old-login' } }));
    expect(await f.drain()).toEqual([]);
    expect(f.calls.some((c) => new URL(c.url).pathname === '/user')).toBe(true);
  });

  test('旧 PR カーソルの本人を確認し直すと新 login の本人作成 PR が届く', async () => {
    const f = fixture();
    f.data.pulls.push(fakePull(101, { user: { id: 42, login: 'new-login' } }));
    expect((await f.drain()).map((i) => i.sourceId)).toEqual(['800101']);
  });

  test('作者が別 ID でも、担当者の不変 ID が本人なら新 login の PR が届く', async () => {
    const f = fixture();
    f.data.pulls.push(
      fakePull(101, {
        user: { id: 99, login: 'fake-other' },
        assignee: { id: 42, login: 'new-login' },
        assignees: [{ id: 42, login: 'new-login' }],
      }),
    );
    expect((await f.drain()).map((i) => i.sourceId)).toEqual(['800101']);
  });

  test('取得途中で本人の login が再び変わっても同じ ID の次頁の PR を取り込む', async () => {
    const f = fixture();
    f.data.pulls = Array.from({ length: 101 }, (_, i) => fakePull(i + 1, { user: { id: 42, login: 'new-login' } }));
    const first: ImportItem[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 10; step++) {
      const result = await f.page(cursor);
      first.push(...result.items);
      cursor = result.next;
      if (result.items.some((i) => i.kind === 'pull_request')) break;
    }
    expect(first).toHaveLength(100);
    expect(cursor).not.toBeNull();
    f.data.owner.login = 'renamed-again';
    f.data.pulls[0] = fakePull(1, { user: { id: 42, login: 'renamed-again' } });
    const rest = await f.drain(cursor);
    expect(rest.map((i) => i.sourceId)).toEqual(['800001']);
    expect(new Set([...first, ...rest].map((i) => i.sourceId)).size).toBe(101);
  });
});

describe('本人 ID の無い旧カーソルからの移行', () => {
  test.each([OLD_ISSUE_CURSOR, `v1:issues:${OLD_ISSUE_CURSOR}`, OLD_PULL_CURSOR])(
    '%s でも要求予算を超えず本人確認と取得を再開できる',
    async (cursor) => {
      const f = fixture();
      f.data.issues = [
        {
          ...fakeIssue(PULL_SCOPE.name, 201),
          assignee: { id: 42, login: 'new-login' },
          assignees: [{ id: 42, login: 'new-login' }],
        },
      ];
      f.data.pulls.push(fakePull(101, { user: { id: 42, login: 'new-login' } }));
      const items = await f.drain(cursor);
      expect(items.filter((i) => i.kind === 'pull_request').map((i) => i.sourceId)).toEqual(['800101']);
      if (cursor !== OLD_PULL_CURSOR) {
        expect(items.filter((i) => i.kind === 'issue').map((i) => i.sourceId)).toEqual(['500201']);
      }
      expect(f.calls.some((c) => new URL(c.url).pathname === '/user')).toBe(true);
    },
  );

  test.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ] as const)('移行時の本人確認 %i を %s として返す', async (status, failure) => {
    const f = fixture();
    f.data.userFailure = status;
    const error: unknown = await f.drain().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportSourceError);
    expect(error).toMatchObject({ failure });
    expect(String(error)).not.toContain(PULL_PAT);
    expect(String(error)).not.toContain('SECRET');
    expect(f.calls.every((c) => new URL(c.url).pathname === '/user')).toBe(true);
  });

  test('本人確認の応答に不変 ID が無ければ login だけを信じず unavailable', async () => {
    const f = fixture();
    delete f.data.owner.id;
    await expect(f.drain(null)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  test.each([
    ['作者', { user: { id: undefined, login: 'new-login' } }],
    [
      '担当者',
      {
        user: { id: 99, login: 'fake-other' },
        assignee: { id: undefined, login: 'new-login' },
        assignees: [{ id: undefined, login: 'new-login' }],
      },
    ],
  ])('PR の%sに不変 ID が無ければ login で代えず unavailable', async (_name, patch) => {
    const f = fixture();
    // undefined の明示指定で fake の補完を使わず、JSON 応答から id を欠落させる。
    f.data.pulls = [fakePull(1, patch)];
    await expect(f.drain(null)).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
