import { expect, test, vi } from 'vitest';
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { load } from '../routes/+page.ts';
import { operationPath } from '../shared/operations/define.ts';
import { myOrganizations } from '../shared/operations/organization/index.ts';

// 組織を選ぶ前には共通の一覧だけを読み、組織の中の読み取りを増やさない。
test('1組織でも転送せず、共通の一覧だけを読んでダッシュボードに返す', async () => {
  const account = {
    organizations: [{ slug: 'aoba', name: 'あおば開発', kind: 'team' }],
    invitations: [],
    operator: false,
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(account));
  const data = await load({ fetch: fetcher, url: new URL('https://example.test/') } as unknown as Parameters<
    typeof load
  >[0]);
  expect(data).toEqual({ ...account, failed: false, suspended: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(operationPath(myOrganizations));
});

test('入れる組織も招待も無い運用者は、運用の画面へ転送する', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ organizations: [], invitations: [], operator: true }),
  );
  await expect(
    load({ fetch: fetcher, url: new URL('https://example.test/') } as unknown as Parameters<typeof load>[0]),
  ).rejects.toMatchObject({ status: 307, location: '/operator' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
