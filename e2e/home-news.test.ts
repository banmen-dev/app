// 組織のホームの「Banmen のニュース」の面。一覧は画面のコード（src/lib/news.ts）に置いてあり、API も DB も通らないので、
// どの組織でも同じものが出る。ここでは、今の一覧が面に出ること（見出し、日付と題と本文）と、左の列で今日やることの下に並ぶことを確かめる。
// 並びと上限、一覧の形は src/lib/news.test.ts、リンクの属性（新しいタブ、external の印）、リンクにしない形、空の一覧は
// src/lib/components/NewsPane.test.ts が確かめる。今の一覧にリンク付きの件が無い間は、画面でのリンクの検査は未実施（テストは skip と注記で示す）。
// seed のセッション（seed/sessions.ts）の Cookie で開く。一般のユーザーはハルカ（あおば開発）、ひばり工房の管理者はリン
import type { Page } from '@playwright/test';
import { latestNews } from '../src/lib/news.ts';
import { word } from '../src/shared/vocabulary.ts';
import { expect, test } from './fixtures.ts';
import { NARROW_VIEWPORT, signIn } from './helpers.ts';

// 面の見出しは辞書から作る（製品名は appName）
const NEWS = word('paneNews', { app: word('appName') });

async function openNews(page: Page, slug: string) {
  await page.goto(`/${slug}`);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  const pane = page.getByRole('region', { name: NEWS, exact: true });
  await expect(pane).toBeVisible();
  return pane;
}

test('組織のホームに、ニュースの面が h2 の見出し付きで出て、今の一覧の日付と題（h3）と本文が出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  const pane = await openNews(page, 'aoba');
  await expect(pane.getByRole('heading', { level: 2, name: NEWS })).toBeVisible();
  const expected = latestNews();
  expect(expected.length).toBeGreaterThan(0);
  const items = pane.getByRole('listitem');
  await expect(items).toHaveCount(expected.length);
  for (const [index, news] of expected.entries()) {
    const item = items.nth(index);
    await expect(item.locator('time')).toHaveText(news.date);
    await expect(item.locator('time')).toHaveAttribute('datetime', news.date);
    await expect(item.getByRole('heading', { level: 3, name: news.title })).toBeVisible();
    await expect(item).toContainText(news.body);
  }
});

// 今の一覧にリンク付きの件が無いと、画面でのリンクの検査は1行も走らない。その間は skip にして未実施と分かるようにする
// （リンクの属性は src/lib/components/NewsPane.test.ts が確かめる）
const LINKED = latestNews().filter((news) => news.href !== undefined);
test('リンク付きのニュースの題が、新しいタブで開くリンクになっている', async ({ page, context, baseURL }) => {
  test.skip(
    LINKED.length === 0,
    '今の一覧にリンク付きのニュースが無いので、画面でのリンクの検査は未実施（属性は NewsPane.test.ts）',
  );
  await signIn(context, baseURL, 'member');
  const pane = await openNews(page, 'aoba');
  for (const news of LINKED) {
    const link = pane.getByRole('link', { name: news.title });
    await expect(link).toHaveAttribute('href', news.href!);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link.locator('svg use')).toHaveAttribute('href', '#i-external');
  }
});

test('ほかの組織（ひばり工房）のホームにも、同じニュースが出る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'otherOrg');
  const pane = await openNews(page, 'hibari');
  for (const news of latestNews()) await expect(pane).toContainText(news.title);
});

test('広い幅では左の列の今日やることの面の下、狭い幅では今日やることの下に縦に並ぶ', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  const boxes = async () => {
    const news = await openNews(page, 'aoba');
    const today = page.getByRole('region', { name: '今日やること', exact: true });
    await expect(today).toBeVisible();
    const [n, t] = await Promise.all([news.boundingBox(), today.boundingBox()]);
    if (n === null || t === null) throw new Error('面の位置が取れない');
    return { news: n, today: t };
  };

  const wide = await boxes();
  expect(wide.news.y).toBeGreaterThanOrEqual(wide.today.y + wide.today.height);
  expect(wide.news.x).toBeCloseTo(wide.today.x, 0);
  expect(wide.news.width).toBeCloseTo(wide.today.width, 0);

  await page.setViewportSize(NARROW_VIEWPORT);
  const narrow = await boxes();
  expect(narrow.news.y).toBeGreaterThanOrEqual(narrow.today.y + narrow.today.height);
  expect(narrow.news.x).toBeCloseTo(narrow.today.x, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
