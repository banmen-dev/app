import { describe, expect, test } from 'vitest';
import { importSourceOf } from '../../src/server/import/index.ts';
import { fakePull, ownPullFixture, PULL_LOGIN, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

const source = importSourceOf('github');
const firstPull = `v1:pulls:${PULL_LOGIN}:1`;

async function page(f: ReturnType<typeof ownPullFixture>, cursor: string | null = firstPull) {
  if (cursor === firstPull) {
    const migration = await source.fetchPage({
      credential: PULL_PAT,
      fetcher: f.fetcher,
      scope: PULL_SCOPE,
      settings: {},
      cursor,
    });
    expect(migration.items).toEqual([]);
    expect(migration.next).not.toBeNull();
    cursor = migration.next;
  }
  return source.fetchPage({ credential: PULL_PAT, fetcher: f.fetcher, scope: PULL_SCOPE, settings: {}, cursor });
}

describe('反証: PR の範囲と頁境界', () => {
  test('同じ作者・番号・URLでも base.repo の不変IDが範囲外なら取り込まない', async () => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1, { base: { repo: { id: 1002, full_name: PULL_SCOPE.name } } })];
    await expect(page(f)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  test('フォークからのPRは head.repo が範囲外でも base.repo が範囲内なら届く', async () => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1, { head: { repo: { id: 9009, full_name: 'guild-fake/fork' } } })];
    const result = await page(f);
    expect(result.items.map((item) => item.sourceId)).toEqual(['800001']);
    expect(result.next).toBeNull();
  });

  test('改名後の表示キーは範囲名ではなく応答URLから作り、取得は不変IDを使う', async () => {
    const f = ownPullFixture();
    f.data.pulls = [
      fakePull(1, {
        base: { repo: { id: 1001, full_name: 'guild-fake/renamed' } },
        html_url: 'https://github.com/guild-fake/renamed/pull/1',
      }),
    ];
    const result = await page(f);
    expect(result.items[0]).toMatchObject({
      sourceId: '800001',
      key: 'guild-fake/renamed#1',
      url: 'https://github.com/guild-fake/renamed/pull/1',
      containerId: '1001',
    });
    expect(new URL(f.calls[1]!.url).pathname).toBe('/repositories/1001/pulls');
  });

  test('閉じたPRだけの満杯頁でも終わらず、後続のPRへ進む', async () => {
    const f = ownPullFixture();
    f.data.pulls = [
      // 更新日時の新しい順に読むので、未完了の PR を最も古くして、閉じた PR だけの満杯頁の後ろに置く
      fakePull(1),
      ...Array.from({ length: 100 }, (_, index) => fakePull(index + 2, { state: 'closed' })),
    ];
    const first = await page(f);
    expect(first.items).toHaveLength(100);
    expect(first.items.every((item) => item.isDone && item.status === 'closed')).toBe(true);
    expect(first.next).not.toBeNull();
    const second = await page(f, first.next);
    expect(second.items.map((item) => item.sourceId)).toEqual(['800001']);
    expect(second.next).toBeNull();
  });

  test('同じPRが1頁内で重なっても後の属性で1件だけ返す', async () => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1), fakePull(1, { title: '更新後の架空の題' })];
    const result = await page(f);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('更新後の架空の題');
  });

  test('頁上限を無視する101件の応答は途中だけを取り込まず断る', async () => {
    const f = ownPullFixture();
    f.data.pullBody = Array.from({ length: 101 }, (_, index) => fakePull(index + 1));
    await expect(page(f)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  test('PR段階の失敗後も同じカーソルで再試行でき、本人照会やIssueへ戻らない', async () => {
    const f = ownPullFixture();
    f.data.pulls = Array.from({ length: 101 }, (_, index) => fakePull(index + 1));
    const first = await page(f);
    f.data.pullFailure = 429;
    await expect(page(f, first.next)).rejects.toMatchObject({ failure: 'forbidden' });
    f.data.pullFailure = 0;
    const retry = await page(f, first.next);
    expect(retry.items.map((item) => item.sourceId)).toEqual(['800001']);
    expect(retry.next).toBeNull();
    const pulls = f.calls.filter((call) => new URL(call.url).pathname.endsWith('/pulls'));
    expect(pulls.map((call) => new URL(call.url).searchParams.get('page'))).toEqual(['1', '2', '2']);
    expect(f.calls.filter((call) => new URL(call.url).pathname === '/user')).toHaveLength(1);
  });
});

describe('反証: 新旧カーソルの不正値', () => {
  test.each([
    'v1:pulls:fake-ranger:0',
    'v1:pulls:fake-ranger:1000001',
    'v1:pulls:fake-ranger:1:extra',
    'v1:pulls:https://evil.example:1',
    'v2:pulls:fake-ranger:1',
    'v1:issues:fake-ranger:1:2026-02-30T00:00:00.000Z',
    'fake-ranger:1:2026-13-01T00:00:00.000Z',
  ])('%s は外部問い合わせ前に拒否する', async (cursor) => {
    const f = ownPullFixture();
    await expect(page(f, cursor)).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });
});
