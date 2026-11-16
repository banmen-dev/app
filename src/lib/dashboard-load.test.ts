import { expect, test, vi } from 'vitest';
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { load } from '../routes/+page.ts';
import { operationPath } from '../shared/operations/define.ts';
import { myOrganizations } from '../shared/operations/organization/index.ts';
import { myToday } from '../shared/operations/organization/my-today.ts';

const account = {
  organizations: [{ slug: 'aoba', name: 'あおば開発', kind: 'team' }],
  invitations: [],
  operator: false,
};
const today = { tasks: [], omitted_organizations: 0, failed_organizations: [] };
const event = (fetch: typeof globalThis.fetch) =>
  ({ fetch, url: new URL('https://example.test/') }) as unknown as Parameters<typeof load>[0];

test('1組織でも転送せず、組織の一覧と本人の今日やることを並行して読む', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    await gate;
    return Response.json(url === operationPath(myToday) ? today : account);
  });
  const pending = load(event(fetcher));
  expect(fetcher).toHaveBeenCalledTimes(2);
  release();
  expect(await pending).toEqual({ ...account, failed: false, suspended: [], today });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([operationPath(myOrganizations), operationPath(myToday)]);
});

test('今日の読取失敗でも組織の一覧を残す', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === operationPath(myToday)
      ? Response.json({ error: { code: 'internal' } }, { status: 500 })
      : Response.json(account),
  );
  expect(await load(event(fetcher))).toEqual({ ...account, failed: false, suspended: [], today: null });
});

test('入れる組織も招待も無い運用者は、運用の画面へ転送する', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    Response.json(url === operationPath(myToday) ? today : { organizations: [], invitations: [], operator: true }),
  );
  await expect(load(event(fetcher))).rejects.toMatchObject({ status: 307, location: '/operator' });
});

test.each([401, 403])('本人を確かめられないときはダッシュボードを出さず転送する (%i)', async (status) => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ error: { code: status === 401 ? 'unauthenticated' : 'terms_required' } }, { status }),
  );
  await expect(load(event(fetcher))).rejects.toMatchObject({ status: 307 });
});
