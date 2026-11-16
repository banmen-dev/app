import { describe, expect, test } from 'vitest';
import { importSourceOf } from '../../src/server/import/index.ts';
import { fakePull, ownPullFixture, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

const source = importSourceOf('github');

describe('本人 ID のカーソル境界', () => {
  test('設定の login だけでは本人を確定せず、初回に PAT 本人を確認する', async () => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1), fakePull(2, { user: { id: 99, login: 'fake-intruder' } })];
    const input = { credential: PULL_PAT, fetcher: f.fetcher, scope: PULL_SCOPE, settings: { login: 'fake-intruder' } };
    const first = await source.fetchPage({ ...input, cursor: null });
    expect(f.calls).toHaveLength(2);
    expect(new URL(f.calls[0]!.url).pathname).toBe('/user');
    const pulls = await source.fetchPage({ ...input, cursor: first.next });
    expect(pulls.items.map((item) => item.sourceId)).toEqual(['800001']);
    expect(f.calls).toHaveLength(3);
  });

  test.each([
    'v2:pulls:0:fake-ranger:1',
    'v2:pulls:9007199254740992:fake-ranger:1',
    'v2:pulls:42:fake-ranger:0',
    'v2:pulls:42:fake-ranger:1000001',
    'v2:issues:42:fake-ranger:1:2026-02-30T00:00:00.000Z',
    'v2:issues:42:fake-ranger:0:',
  ])('%s は本人照会前に拒否する', async (cursor) => {
    const f = ownPullFixture();
    await expect(
      source.fetchPage({ credential: PULL_PAT, fetcher: f.fetcher, scope: PULL_SCOPE, settings: {}, cursor }),
    ).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });
});
