import { describe, expect, test } from 'vitest';
import { importSourceOf, ImportSourceError, type ImportItem } from '../../src/server/import/index.ts';
import { fakeIssue } from './fake-github-pat.ts';
import { fakePull, ownPullFixture, PULL_LOGIN, PULL_PAT, PULL_SCOPE } from './fake-github-pulls.ts';

const source = importSourceOf('github');
type Fixture = ReturnType<typeof ownPullFixture>;

function page(f: Fixture, cursor: string | null = null, settings: Record<string, unknown> = {}) {
  return source.fetchPage({ credential: PULL_PAT, fetcher: f.fetcher, scope: PULL_SCOPE, settings, cursor });
}

async function drain(f: Fixture, cursor: string | null = null, settings: Record<string, unknown> = {}) {
  const items: ImportItem[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < 100; step++) {
    const before = f.calls.length;
    const result = await page(f, cursor, settings);
    expect(result.items.length).toBeLessThanOrEqual(100);
    // 呼び口1回で一覧を走査し切らず、既存の同期側の頁予算で止められる。
    expect(f.calls.length - before).toBeLessThanOrEqual(cursor === null && !settings.login ? 2 : 1);
    items.push(...result.items);
    if (result.next === null) return items;
    expect(result.next.length).toBeLessThanOrEqual(2000);
    expect(seen.has(result.next)).toBe(false);
    seen.add(result.next);
    cursor = result.next;
  }
  throw new Error('100回以内に取得が完了しない');
}

describe('ランタイム: 偽の応答に使う workerd の Request / Response', () => {
  test('manual とヘッダーを保持し、JSON の本文は一度だけ読める', async () => {
    const request = new Request('https://api.github.com/repositories/1001/pulls', {
      redirect: 'manual',
      headers: { Authorization: 'Bearer fake' },
    });
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('authorization')).toBe('Bearer fake');
    const response = Response.json([{ id: 1 }]);
    expect(await response.json()).toEqual([{ id: 1 }]);
    expect(response.bodyUsed).toBe(true);
    await expect(response.json()).rejects.toThrow();
    const redirect = new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } });
    expect(redirect.ok).toBe(false);
    expect(redirect.status).toBe(302);
  });
});

describe('完了条件: 作者か担当者が自分の PR', () => {
  test('作者のみ・担当のみ・両方を各1件、Issue と別種で変換する', async () => {
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 7)];
    f.data.pulls = [
      fakePull(1),
      fakePull(2, {
        user: { login: 'fake-other' },
        assignee: { login: PULL_LOGIN },
        assignees: [{ login: PULL_LOGIN }],
      }),
      fakePull(3, { assignee: { login: PULL_LOGIN }, assignees: [{ login: PULL_LOGIN }] }),
    ];
    const items = await drain(f);
    expect(items.filter((i) => i.kind === 'issue').map((i) => i.sourceId)).toEqual(['500007']);
    const pulls = items.filter((i) => i.kind === 'pull_request');
    expect(pulls.map((i) => i.sourceId).sort()).toEqual(['800001', '800002', '800003']);
    expect(pulls.find((i) => i.sourceId === '800001')).toEqual({
      kind: 'pull_request',
      sourceId: '800001',
      reviewerSourceId: '',
      key: `${PULL_SCOPE.name}#1`,
      url: `https://github.com/${PULL_SCOPE.name}/pull/1`,
      title: '架空の課題 1',
      containerId: PULL_SCOPE.id,
      containerName: PULL_SCOPE.name,
      status: 'open',
      dueOn: null,
      updatedAt: '2026-01-01T00:01:00.000Z',
      isDone: false,
    });
  });

  test('閉じた PR は完了の印つきで返し（マージ済みは merged）、他人の PR は API が絞り込みを無視しても返さない', async () => {
    const f = ownPullFixture();
    f.data.loose = true;
    f.data.pulls = [
      fakePull(1, { state: 'closed' }),
      fakePull(2, { user: { login: 'fake-other' } }),
      fakePull(3),
      fakePull(4, { state: 'closed', merged_at: '2026-01-02T00:00:00Z' }),
    ];
    const items = (await drain(f)).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    expect(items.map((i) => [i.sourceId, i.status, i.isDone])).toEqual([
      ['800001', 'closed', true],
      ['800003', 'open', false],
      ['800004', 'merged', true],
    ]);
    expect(f.calls.every((c) => !c.url.includes('/repositories/') || c.url.includes('/repositories/1001/'))).toBe(true);
  });

  test('ログインの大小文字を区別せず、複数担当者の中に本人がいても届く', async () => {
    const f = ownPullFixture();
    f.data.pulls = [
      fakePull(1, { user: { login: 'Fake-Ranger' } }),
      fakePull(2, {
        user: { login: 'fake-other' },
        assignees: [{ login: 'fake-other' }, { login: 'FAKE-RANGER' }],
      }),
    ];
    expect((await drain(f)).map((i) => i.sourceId).sort()).toEqual(['800001', '800002']);
  });

  test.each([0, 1, 99, 100, 101, 250, 1205])(
    '%i 件は頁をまたいでも漏れない（検索の1,000件上限に頼らない）',
    async (count) => {
      const f = ownPullFixture();
      f.data.pulls = Array.from({ length: count }, (_, i) => fakePull(i + 1));
      const items = await drain(f);
      expect(new Set(items.map((i) => i.sourceId))).toEqual(new Set(f.data.pulls.map((p) => String(p.id))));
      expect(f.calls.filter((c) => new URL(c.url).pathname === '/user')).toHaveLength(1);
    },
  );

  test('更新や終了で既読の PR が一覧の先頭から消えても未読の PR を漏らさない', async () => {
    const f = ownPullFixture();
    f.data.pulls = Array.from({ length: 250 }, (_, i) => fakePull(i + 1));
    const seen: ImportItem[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 10; n++) {
      const result = await page(f, cursor);
      seen.push(...result.items);
      cursor = result.next;
      if (result.items.some((i) => i.kind === 'pull_request')) break;
    }
    expect(seen.filter((i) => i.kind === 'pull_request')).toHaveLength(100);
    // 読み終えた頁の PR が更新（終了）されて先頭へ動いても、後ろの頁の未読の PR は頁をずれるだけで漏れない
    f.data.pulls[200] = { ...f.data.pulls[200], state: 'closed', updated_at: '2026-06-01T00:00:00Z' };
    const rest = cursor === null ? [] : await drain(f, cursor);
    expect(new Set([...seen, ...rest].map((i) => i.sourceId)).size).toBe(250);
  });

  test('同じ更新日時が頁を超えても終了し、全件を返す', async () => {
    const f = ownPullFixture();
    f.data.pulls = Array.from({ length: 230 }, (_, i) => fakePull(i + 1, { updated_at: '2026-02-02T00:00:00Z' }));
    expect(new Set((await drain(f)).map((i) => i.sourceId)).size).toBe(230);
  });

  test('既存の Issue カーソルから再開して、残りの Issue と PR を取れる', async () => {
    const f = ownPullFixture();
    f.data.issues = [fakeIssue(PULL_SCOPE.name, 20)];
    f.data.pulls = [fakePull(1)];
    const items = await drain(f, `${PULL_LOGIN}:1:2026-01-01T00:10:00.000Z`);
    expect(items.map((i) => `${i.kind}:${i.sourceId}`).sort()).toEqual(['issue:500020', 'pull_request:800001']);
  });
});

describe('断る場合: PR の応答と通信', () => {
  test.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'forbidden'],
    [500, 'unavailable'],
    [302, 'unavailable'],
  ] as const)('PR 取得の %i を %s に分け、認証情報を出さない', async (status, failure) => {
    const f = ownPullFixture();
    f.data.pullFailure = status;
    const error: unknown = await drain(f).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportSourceError);
    expect(error).toMatchObject({ failure });
    expect(String(error)).not.toContain(PULL_PAT);
    expect(String(error)).not.toContain('SECRET');
  });

  test.each([
    ['別ホストの URL', { html_url: 'https://evil.example/guild-fake/alpha/pull/1' }],
    ['番号不一致', { html_url: `https://github.com/${PULL_SCOPE.name}/pull/2` }],
    ['不正な ID', { id: 0 }],
    ['不正な更新日時', { updated_at: 'きのう' }],
    ['長すぎる題', { title: 'あ'.repeat(257) }],
  ])('%s は不正なタスクとして返さない', async (_name, patch) => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1, patch)];
    await expect(drain(f)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  test('固定ホスト・Bearer・manual・signal を PR の要求にも使う', async () => {
    const f = ownPullFixture();
    f.data.pulls = [fakePull(1)];
    await drain(f);
    const pulls = f.calls.filter((c) => new URL(c.url).pathname.endsWith('/pulls'));
    expect(pulls.length).toBeGreaterThan(0);
    for (const call of pulls) {
      expect(call.headers.get('authorization')).toBe(`Bearer ${PULL_PAT}`);
      expect(call.redirect).toBe('manual');
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
