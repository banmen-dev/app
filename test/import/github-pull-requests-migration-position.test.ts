// 旧カーソルの移行で、段階・頁・更新日時の起点を保つことを HTTP 要求から確かめる。
import { describe, expect, test } from 'vitest';
import { importSourceOf } from '../../src/server/import/index.ts';
import { PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

const source = importSourceOf('github');
const oldIssuePosition = 'old-login:3:2026-01-01T00:00:00.000Z';

function fixture() {
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.github.com') throw new Error('想定外のホスト');
    if (url.pathname === '/user') return Response.json({ type: 'User', id: 42, login: 'new-login' });
    if (url.pathname === '/repositories/1001/issues' || url.pathname === '/repositories/1001/pulls') {
      return Response.json([]);
    }
    throw new Error('想定外の要求');
  };
  async function page(cursor: string) {
    const before = calls.length;
    const result = await source.fetchPage({ credential: PULL_PAT, fetcher, scope: PULL_SCOPE, settings: {}, cursor });
    expect(calls.length - before).toBe(1);
    return result;
  }
  async function migrate(cursor: string) {
    const result = await page(cursor);
    expect(result.items).toEqual([]);
    expect(result.next).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/user');
    if (result.next === null) throw new Error('本人確認後の続きの位置が無い');
    return result.next;
  }
  return { calls, page, migrate };
}

describe('旧カーソル移行後の取得位置', () => {
  test.each([oldIssuePosition, `v1:issues:${oldIssuePosition}`])(
    '%s の頁と起点を保ち、現在の本人名で Issue を再開する',
    async (cursor) => {
      const f = fixture();
      const next = await f.migrate(cursor);
      await f.page(next);
      expect(f.calls).toHaveLength(2);
      const url = new URL(f.calls[1]!.url);
      expect(url.pathname).toBe('/repositories/1001/issues');
      expect(url.searchParams.get('page')).toBe('3');
      expect(url.searchParams.get('assignee')).toBe('new-login');
      expect(url.searchParams.get('since')).toBe('2025-12-31T23:59:59.000Z');
      expect(url.searchParams.get('state')).toBe('open');
    },
  );

  test('旧 PR カーソル（作成順の頁）は、本人確認後に更新日時の降順で先頭の頁から読み直す', async () => {
    const f = fixture();
    const next = await f.migrate('v1:pulls:old-login:2');
    await f.page(next);
    expect(f.calls).toHaveLength(2);
    const url = new URL(f.calls[1]!.url);
    expect(url.pathname).toBe('/repositories/1001/pulls');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('state')).toBe('all');
    expect(url.searchParams.get('sort')).toBe('updated');
    expect(url.searchParams.get('direction')).toBe('desc');
  });
});
