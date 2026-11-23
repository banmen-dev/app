// #1241 請求画面の読み込み（src/routes/auth/billing/+page.ts）を、fetch を差し替えて崩しにかかる。
// 見るのは、一覧に無い slug・承諾待ちの slug で契約と使用量を呼ばないこと、選んだ組織で2つの操作を並べて呼ぶこと、
// 契約と使用量の取得だけが失敗したときに担当者の管理まで巻き込まないこと
import { describe, expect, test, vi } from 'vitest';
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { load } from '../routes/auth/billing/+page.ts';
import { operationPath } from '../shared/operations/define.ts';
import { billingAdminList, billingOrganizationSummary, myBillingOrganizations } from '../shared/operations/billing.ts';

const listPath = operationPath(myBillingOrganizations);
const adminsPath = operationPath(billingAdminList);
const summaryPath = operationPath(billingOrganizationSummary);

const mine = {
  account_id: 'acct-fictional-0001',
  operator: false,
  organizations: [{ slug: 'aoba', name: 'あおば開発', kind: 'team', plan: 'team', state: 'active' }],
  invitations: [{ id: '0190a000-0000-7000-8000-000000000001', slug: 'kaede', name: 'かえで製作所' }],
};
const admins = { administrators: [], events: [] };
const summary = {
  kind: 'team',
  state: 'active',
  purge_on: null,
  purge_due: false,
  trial_ends_on: null,
  contract: null,
  member_limit: 10,
  attachment_quota_bytes: 30 * 1024 ** 3,
  usage: { seats_used: 1, attachment_used_bytes: 0 },
};

type Reply = { status: number; body: unknown };
const okReply = (body: unknown): Reply => ({ status: 200, body });
const failure = (status: number, code: string): Reply => ({ status, body: { error: { code, message: 'x' } } });

function fetcherOf(replies: Record<string, Reply | (() => Promise<Reply>)>) {
  return vi.fn<typeof fetch>(async (input) => {
    const entry = replies[String(input)];
    const reply = typeof entry === 'function' ? await entry() : (entry ?? { status: 500, body: 'no reply' });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
}
const eventOf = (fetcher: typeof fetch, url: string) =>
  ({ fetch: fetcher, url: new URL(url) }) as unknown as Parameters<typeof load>[0];

async function redirectOf(run: () => unknown) {
  try {
    await run();
  } catch (thrown) {
    const { status, location } = thrown as { status?: number; location?: string };
    if (typeof status === 'number' && typeof location === 'string') return { status, location };
    throw thrown;
  }
  return undefined;
}
const calledPaths = (fetcher: ReturnType<typeof fetcherOf>) => fetcher.mock.calls.map(([input]) => String(input));

describe('一覧に無い slug', () => {
  test.each([
    ['担当していない組織', 'other'],
    ['承諾待ちの組織（指名が届いただけ）', 'kaede'],
    ['大文字にした slug', 'AOBA'],
    ['空の slug', ''],
  ])('%s: 一覧へ戻し、担当者と契約と使用量を呼ばない', async (_name, slug) => {
    const fetcher = fetcherOf({ [listPath]: okReply(mine) });
    const location = await redirectOf(() =>
      load(eventOf(fetcher, `https://example.test/auth/billing?organization=${encodeURIComponent(slug)}`)),
    );
    expect(location).toEqual({ status: 307, location: '/auth/billing' });
    expect(calledPaths(fetcher)).toEqual([listPath]);
  });
});

describe('選んだ組織', () => {
  test('担当者の一覧と契約と使用量を並べて呼ぶ（片方の応答を待たずにもう片方を呼ぶ）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetcher = fetcherOf({
      [listPath]: okReply(mine),
      [adminsPath]: async () => {
        await gate;
        return okReply(admins);
      },
      [summaryPath]: async () => {
        await gate;
        return okReply(summary);
      },
    });
    const pending = load(eventOf(fetcher, 'https://example.test/auth/billing?organization=aoba'));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(calledPaths(fetcher).slice(1).sort()).toEqual([adminsPath, summaryPath].sort());
    release();
    const result = (await pending) as { failed: boolean; selected: { summary: unknown } | null };
    expect(result.failed).toBe(false);
    expect(result.selected?.summary).toEqual(summary);
  });

  test('契約と使用量に送る slug は、選んだ組織の slug だけ', async () => {
    const fetcher = fetcherOf({
      [listPath]: okReply(mine),
      [adminsPath]: okReply(admins),
      [summaryPath]: okReply(summary),
    });
    await load(eventOf(fetcher, 'https://example.test/auth/billing?organization=aoba'));
    const call = fetcher.mock.calls.find(([input]) => String(input) === summaryPath);
    expect(call).toBeDefined();
    expect(JSON.parse(String(call![1]?.body))).toEqual({ slug: 'aoba' });
  });

  test('組織を選ばなければ、契約と使用量を呼ばない', async () => {
    const fetcher = fetcherOf({ [listPath]: okReply(mine) });
    const result = await load(eventOf(fetcher, 'https://example.test/auth/billing'));
    expect(result).toMatchObject({ failed: false, selected: null });
    expect(calledPaths(fetcher)).toEqual([listPath]);
  });
});

// Issue #1241 の「案の比較」: 使用量を billing-admin-list に広げる案は「組織の DB を読む失敗や負荷が担当者の管理まで巻き込むため採らなかった」。
// +page.ts のコメントも「失敗や負荷を担当者の管理に巻き込まない」。契約と使用量だけが失敗しても、担当者の一覧（指名・解除）は使えるべき
describe('契約と使用量の取得だけが失敗したとき', () => {
  test.each([
    ['500（組織の DB の読み取りの失敗）', failure(500, 'internal')],
    ['通信の失敗に相当する 503', failure(503, 'unavailable')],
  ])('%s: 画面全体を読み込みの失敗にせず、担当者の一覧は返す', async (_name, reply) => {
    const fetcher = fetcherOf({ [listPath]: okReply(mine), [adminsPath]: okReply(admins), [summaryPath]: reply });
    const result = (await load(eventOf(fetcher, 'https://example.test/auth/billing?organization=aoba'))) as {
      failed: boolean;
      selected?: { administrators?: unknown } | null;
    };
    expect(result.failed).toBe(false);
    expect(result.selected?.administrators).toEqual([]);
  });
});
