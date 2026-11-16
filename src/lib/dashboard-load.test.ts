import { expect, test, vi } from 'vitest';
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { load } from '../routes/+page.ts';
import { operationPath } from '../shared/operations/define.ts';
import { myOrganizations } from '../shared/operations/organization/index.ts';

const account = {
  organizations: [{ slug: 'aoba', name: 'あおば開発', kind: 'team' }],
  invitations: [],
  operator: false,
};
const event = (fetch: typeof globalThis.fetch) =>
  ({ fetch, url: new URL('https://example.test/') }) as unknown as Parameters<typeof load>[0];

// 今日やることは面が読む。組織の入口、ログインと運用者の振り分けはその読み込みを始めずに返す。
test('1組織でも転送せず、my-today を呼ばずに組織の一覧を返す', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(account));
  expect(await load(event(fetcher))).toEqual({ ...account, failed: false, suspended: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([operationPath(myOrganizations)]);
});

test('組織の一覧を読めなければ、今日の読み取りを始めず失敗を返す', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'internal' } }, { status: 500 }));
  expect(await load(event(fetcher))).toEqual({ failed: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(operationPath(myOrganizations));
});

test('入れる組織も招待も無い運用者は、今日の読み取りを始めず運用の画面へ転送する', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ organizations: [], invitations: [], operator: true }),
  );
  await expect(load(event(fetcher))).rejects.toMatchObject({ status: 307, location: '/operator' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(operationPath(myOrganizations));
});

test.each([401, 403])('本人を確かめられないときは今日を読まず転送する (%i)', async (status) => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ error: { code: status === 401 ? 'unauthenticated' : 'terms_required' } }, { status }),
  );
  await expect(load(event(fetcher))).rejects.toMatchObject({ status: 307 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(operationPath(myOrganizations));
});
