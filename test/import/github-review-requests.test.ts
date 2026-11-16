import { describe, expect, test } from 'vitest';
import {
  importSourceOf,
  ImportSourceError,
  type ImportItem,
  type ReviewRequestPageInput,
} from '../../src/server/import/index.ts';
import { fakePat } from './fake-github-pat.ts';

const credential = fakePat('Review');
const scope = { id: '1001', name: 'guild-fake/alpha' };
const source = importSourceOf('github');
const target = { sourceId: '9001', key: `${scope.name}#7` };
const at = '2026-11-16T10:00:00Z';
function request(id = 101, user = 42) {
  return { event: 'review_requested', id, requested_reviewer: { id: user } };
}
function review(user = 42, state = 'approved') {
  return { event: 'reviewed', id: 201, user: { id: user }, state, submitted_at: at };
}
function fixture() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const data = {
    pull: {
      id: 9001,
      number: 7,
      title: '架空の PR',
      html_url: `https://github.com/${scope.name}/pull/7`,
      state: 'open',
      updated_at: at,
      requested_reviewers: [{ id: 42 }],
    },
    timeline: [[request()]] as unknown[][],
    failure: 0,
    mutate: false,
    others: [] as Record<string, unknown>[],
    timelines: {} as Record<string, unknown[][]>,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    calls.push({ url, init });
    const parsed = new URL(url);
    if (data.failure && parsed.pathname.endsWith('/timeline')) return new Response('', { status: data.failure });
    if (parsed.pathname === '/user') return Response.json({ type: 'User', id: 42, login: 'fake-ranger' });
    if (parsed.pathname.endsWith('/timeline'))
      return Response.json(
        (data.timelines[parsed.pathname.split('/')[4]!] ?? data.timeline)[
          Number(parsed.searchParams.get('page')) - 1
        ] ?? [],
      );
    if (parsed.pathname.endsWith('/pulls'))
      return Response.json(
        [data.pull, ...data.others].slice(
          Number(parsed.searchParams.get('page')) - 1,
          Number(parsed.searchParams.get('page')),
        ),
      );
    if (/\/pulls\/\d+$/.test(parsed.pathname)) {
      if (data.mutate && parsed.pathname.endsWith('/7')) {
        data.pull.updated_at = new Date(Date.parse(data.pull.updated_at) + 1000).toISOString();
      }
      return Response.json(
        [data.pull, ...data.others].find((p) => String(p.number) === parsed.pathname.split('/').at(-1)),
      );
    }
    throw new Error('想定外の要求');
  };
  const page = (cursor: string | null, extra: Partial<ReviewRequestPageInput> = {}) =>
    source.fetchReviewRequestsPage!({ credential, fetcher, scope, settings: {}, cursor, ...extra });
  async function drain(extra: Partial<ReviewRequestPageInput> = {}, cursor: string | null = null) {
    const items: ImportItem[] = [];
    let steps = 0;
    do {
      const before = calls.length;
      const result = await page(cursor, extra);
      expect(calls.length - before).toBe(1);
      if (result.next) expect(result.next.length).toBeLessThanOrEqual(2000);
      items.push(...result.items);
      cursor = result.next;
      if (++steps > 30) throw new Error('取得が終わらない');
    } while (cursor !== null);
    return items;
  }
  return { calls, data, page, drain };
}

describe('レビュー依頼の取得', () => {
  test('自分の不変 ID と依頼イベント ID を共通項目へ渡す', async () => {
    const f = fixture();
    expect(await f.drain()).toEqual([
      expect.objectContaining({
        kind: 'review_request',
        sourceId: '9001',
        reviewerSourceId: '42',
        reviewCycle: '101',
        isDone: false,
        title: '架空の PR',
        key: `${scope.name}#7`,
        containerId: scope.id,
      }),
    ]);
    expect(f.calls[1].url).toContain('state=all&sort=created&direction=asc');
  });
  test('自分宛て以外とチーム宛ては取り込まない', async () => {
    const f = fixture();
    f.data.timeline = [[request(102, 99), { event: 'review_requested', requested_team: { id: 42 } }]];
    f.data.pull.requested_reviewers = [{ id: 99 }];
    expect(await f.drain()).toEqual([]);
  });
  test('コメントレビュー後も依頼一覧に本人が残るときは元完了を返す', async () => {
    const f = fixture();
    f.data.timeline = [[request(), review(42, 'commented')]];
    expect(await f.drain()).toEqual([expect.objectContaining({ isDone: true, reviewCycle: '101' })]);
  });
  test('チーム宛てイベントの requested_reviewer が null でも無視する', async () => {
    const f = fixture();
    f.data.timeline = [[{ event: 'review_requested', requested_reviewer: null, requested_team: { id: 9 } }, request()]];
    expect(await f.drain()).toHaveLength(1);
  });
  test('他人のレビューで完了扱いにしない', async () => {
    const f = fixture();
    f.data.timeline = [[request(), review(99)]];
    expect(await f.drain()).toEqual([expect.objectContaining({ isDone: false })]);
  });
  test.each(['approved', 'changes_requested', 'commented', 'dismissed'])(
    '自分の %s レビューで元完了を返す',
    async (state) => {
      const f = fixture();
      f.data.timeline = [[request(), review(42, state)]];
      f.data.pull.requested_reviewers = [];
      expect(await f.drain()).toEqual([expect.objectContaining({ isDone: true, reviewCycle: '101' })]);
    },
  );
  test('閉じた既存 PR も ID を確認して取得する', async () => {
    const f = fixture();
    f.data.pull.state = 'closed';
    f.data.pull.requested_reviewers = [];
    expect(await f.drain({ target })).toEqual([expect.objectContaining({ isDone: true })]);
    expect(f.calls.some((c) => c.url.includes('/pulls?'))).toBe(false);
  });
  test('提出の後の再依頼は新しい回になる', async () => {
    const f = fixture();
    f.data.timeline = [[request(), review(), request(303)]];
    expect(await f.drain()).toEqual([expect.objectContaining({ isDone: false, reviewCycle: '303' })]);
  });
  test('リポジトリの改名後も不変 ID で取得し現在のキーを返す', async () => {
    const f = fixture();
    f.data.pull.html_url = 'https://github.com/guild-fake/renamed/pull/7';
    expect(await f.drain({ target })).toEqual([
      expect.objectContaining({
        sourceId: '9001',
        key: 'guild-fake/renamed#7',
        containerName: 'guild-fake/renamed',
        url: 'https://github.com/guild-fake/renamed/pull/7',
      }),
    ]);
  });
  test('改名後に返したキーを次の既存依頼照合にも使える', async () => {
    const f = fixture();
    f.data.pull.html_url = 'https://github.com/guild-fake/renamed/pull/7';
    const [first] = await f.drain({ target });
    expect(await f.drain({ target: { sourceId: first!.sourceId, key: first!.key } })).toEqual([first]);
  });
  test('タイトルの更新と再取得では回を変えない', async () => {
    const f = fixture();
    const first = await f.drain();
    f.data.pull.title = '新しい架空の題';
    f.data.pull.updated_at = '2026-11-16T11:00:00Z';
    const second = await f.drain();
    expect(second[0]!.reviewCycle).toBe(first[0]!.reviewCycle);
    expect(second[0]!.title).toBe('新しい架空の題');
  });
  test('履歴の途中では返さず、カーソルを保存・復元して続ける', async () => {
    const f = fixture();
    f.data.timeline = [[request(), ...Array.from({ length: 99 }, () => ({ event: 'commented' }))], [review()]];
    f.data.pull.requested_reviewers = [];
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const result = await f.page(cursor, { target });
      expect(result.items).toEqual([]);
      cursor = result.next;
    }
    expect(JSON.parse(cursor!).historyPage).toBe(2);
    expect(await f.drain({ target }, JSON.parse(JSON.stringify(cursor)))).toEqual([
      expect.objectContaining({ isDone: true }),
    ]);
  });
  test.each([401, 403, 429, 500])('履歴の失敗 %s では項目を返さず、同じカーソルで再試行できる', async (status) => {
    const f = fixture();
    const a = await f.page(null, { target });
    const b = await f.page(a.next, { target });
    f.data.failure = status;
    await expect(f.page(b.next, { target })).rejects.toBeInstanceOf(ImportSourceError);
    f.data.failure = 0;
    expect(await f.drain({ target }, b.next)).toHaveLength(1);
  });
  test('履歴中に変化した PR は古い判定を返さず読み直す', async () => {
    const f = fixture();
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) cursor = (await f.page(cursor, { target })).next;
    f.data.pull.updated_at = '2026-11-16T11:00:00Z';
    f.data.timeline = [[request(), review(), request(303)]];
    const result = await f.page(cursor, { target });
    expect(result.items).toEqual([]);
    expect(await f.drain({ target }, result.next)).toEqual([
      expect.objectContaining({ reviewCycle: '303', isDone: false }),
    ]);
  });
  test('表示番号が同じでも不変 ID の違う PR を返さない', async () => {
    const f = fixture();
    f.data.pull.id = 9002;
    expect(await f.drain({ target })).toEqual([]);
  });
  test('依頼解除で一覧から消えただけなら完了と推測しない', async () => {
    const f = fixture();
    f.data.pull.requested_reviewers = [];
    expect(await f.drain()).toEqual([]);
  });
  test('依頼解除後に閉じた PR を完了済みの依頼として返さない', async () => {
    const f = fixture();
    f.data.timeline = [[request(), { event: 'review_request_removed', requested_reviewer: { id: 42 } }]];
    f.data.pull.requested_reviewers = [];
    f.data.pull.state = 'closed';
    expect(await f.drain()).toEqual([]);
  });
  test('依頼解除後に再依頼されたら新しい回として返す', async () => {
    const f = fixture();
    f.data.timeline = [[request(), { event: 'review_request_removed', requested_reviewer: { id: 42 } }, request(303)]];
    expect(await f.drain()).toEqual([expect.objectContaining({ reviewCycle: '303', isDone: false })]);
  });
  test('本人のレビュー後に依頼が外れても提出の証拠を残す', async () => {
    const f = fixture();
    f.data.timeline = [[request(), review(), { event: 'review_request_removed', requested_reviewer: { id: 42 } }]];
    f.data.pull.requested_reviewers = [];
    expect(await f.drain()).toEqual([expect.objectContaining({ reviewCycle: '101', isDone: true })]);
  });
  test('更新が続く PR は有限回で判定を保留し次の PR へ進む', async () => {
    const f = fixture();
    f.data.mutate = true;
    f.data.others = [{ ...f.data.pull, id: 9002, number: 8, html_url: `https://github.com/${scope.name}/pull/8` }];
    f.data.timelines['8'] = [[request(202)]];
    expect(await f.drain()).toEqual([expect.objectContaining({ sourceId: '9002', reviewCycle: '202' })]);
    expect(f.calls.length).toBeLessThan(20);
  });
  test.each(['missing-cycle', 'bad-title', 'bad-url', 'bad-event'])(
    '1件の不整合 %s が後の PR を塞がない',
    async (kind) => {
      const f = fixture();
      f.data.others = [{ ...f.data.pull, id: 9002, number: 8, html_url: `https://github.com/${scope.name}/pull/8` }];
      f.data.timelines['8'] = [[request(202)]];
      if (kind === 'missing-cycle') f.data.timeline = [[]];
      if (kind === 'bad-title') f.data.pull.title = '';
      if (kind === 'bad-url') f.data.pull.html_url = 'https://example.invalid/pull/7';
      if (kind === 'bad-event') f.data.timeline = [[request(), null]];
      expect(await f.drain()).toEqual([expect.objectContaining({ sourceId: '9002', reviewCycle: '202' })]);
    },
  );
  test('退会した他人のレビューは本人の判定を塞がない', async () => {
    const f = fixture();
    f.data.timeline = [[request(), { event: 'reviewed', user: null }, review()]];
    f.data.pull.requested_reviewers = [];
    expect(await f.drain()).toEqual([expect.objectContaining({ isDone: true })]);
  });
  test('PAT は固定ホストの Authorization だけに送り、リダイレクトしない', async () => {
    const f = fixture();
    await f.drain();
    for (const c of f.calls) {
      expect(new URL(c.url).origin).toBe('https://api.github.com');
      expect(c.url).not.toContain(credential);
      expect(c.init?.redirect).toBe('manual');
      expect((c.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${credential}`);
    }
  });
  test('不正なカーソル・範囲・認証情報は通信前に断る', async () => {
    const f = fixture();
    for (const cursor of ['oops', '{}', JSON.stringify({ phase: 'timeline', pull: { number: '../bad' } })]) {
      await expect(f.page(cursor)).rejects.toThrow();
    }
    await expect(f.page(null, { scope: { id: '../bad', name: scope.name } })).rejects.toThrow();
    await expect(f.page(null, { credential: 'invalid' })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
