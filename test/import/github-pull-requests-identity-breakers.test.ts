import { describe, expect, test } from 'vitest';
import { importSourceOf } from '../../src/server/import/index.ts';
import { fakePull, ownPullFixture, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

const source = importSourceOf('github');
const cursor = 'v2:pulls:42:old-login:1';

function page(f: ReturnType<typeof ownPullFixture>, position = cursor) {
  return source.fetchPage({
    credential: PULL_PAT,
    fetcher: f.fetcher,
    scope: PULL_SCOPE,
    settings: {},
    cursor: position,
  });
}

describe('反証: 不変 ID と PR のユーザー情報', () => {
  test('本人確認済みカーソルの旧 login が第三者に再利用されても、不変 ID を優先する', async () => {
    const f = ownPullFixture();
    f.data.pulls = [
      fakePull(1, { user: { id: 99, login: 'old-login' } }),
      fakePull(2, { user: { id: 42, login: 'renamed-owner' } }),
    ];
    const result = await page(f);
    expect(result.items.map((item) => item.sourceId)).toEqual(['800002']);
    expect(result.next).toBeNull();
    expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual(['/repositories/1001/pulls']);
  });

  test('担当者の先頭が第三者でも、後ろの本人 ID を見落とさず、重複担当でも1件だけ返す', async () => {
    const f = ownPullFixture();
    f.data.pulls = [
      fakePull(1, {
        user: { id: 77, login: 'fake-author' },
        assignee: { id: 99, login: 'old-login' },
        assignees: [
          { id: 99, login: 'old-login' },
          { id: 42, login: 'renamed-owner' },
          { id: 42, login: 'renamed-owner' },
        ],
      }),
    ];
    expect((await page(f)).items.map((item) => item.sourceId)).toEqual(['800001']);
  });

  test('単数の assignee が null でも、assignees に本人 ID があれば届く', async () => {
    const f = ownPullFixture();
    f.data.pulls = [
      fakePull(1, {
        user: { id: 99, login: 'fake-author' },
        assignee: null,
        assignees: [{ id: 42, login: 'renamed-owner' }],
      }),
    ];
    expect((await page(f)).items.map((item) => item.sourceId)).toEqual(['800001']);
  });

  test.each(['42', 42.5, 9_007_199_254_740_992])('作者 ID %s は login 一致でも数値として代用しない', async (id) => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1, { user: { id, login: 'old-login' } })];
    await expect(page(f)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  test('安全な整数の最大値は、カーソルと作者の不変 ID として丸めず照合する', async () => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1, { user: { id: Number.MAX_SAFE_INTEGER, login: 'renamed-owner' } })];
    expect(
      (await page(f, `v2:pulls:${Number.MAX_SAFE_INTEGER}:old-login:1`)).items.map((item) => item.sourceId),
    ).toEqual(['800001']);
  });
});

describe('反証: v2 の本人 ID は正規形だけ', () => {
  test.each(['042', '+42', '4.2e1', '-42', 'NaN'])('%s は通信前に断り、本人照会で補正しない', async (id) => {
    const f = ownPullFixture();
    await expect(page(f, `v2:pulls:${id}:old-login:1`)).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });
});
