import { describe, expect, test } from 'vitest';
import {
  NEWS_BODY_MAX,
  NEWS_LIMIT,
  NEWS_TITLE_MAX,
  isNewsHref,
  latestNews,
  newsItemProblems,
  newsItems,
  type NewsItem,
} from './news.ts';

const item = (date: string, title = `題 ${date}`): NewsItem => ({ date, title, body: '本文' });

// テストを走らせた日（UTC）の YYYY-MM-DD。日付の上限はこの翌日
const TODAY = new Date().toISOString().slice(0, 10);
const good: NewsItem = { date: '2026-11-15', title: '架空の知らせ', body: '架空の本文です。' };
// 検査の日を固定して、日付の境を確かめる
const FIXED_TODAY = '2026-11-15';

describe('ニュースの一覧（src/lib/news.ts に書いたもの）の形', () => {
  test('1件以上ある', () => {
    expect(newsItems.length).toBeGreaterThan(0);
  });

  test('どの件も newsItemProblems の検査を通る（今日は走らせた日）', () => {
    for (const news of newsItems) expect(newsItemProblems(news, TODAY), `${news.date} ${news.title}`).toEqual([]);
  });

  test('同じ日付と題の組は重ならない', () => {
    const keys = newsItems.map((news) => `${news.date}\n${news.title}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('newsItemProblems: 日付', () => {
  test('良い日付は通る。範囲の端（2026-01-01 と検査の日の翌日）も通る', () => {
    for (const date of ['2026-01-01', '2026-11-15', '2026-11-16']) {
      expect(newsItemProblems({ ...good, date }, FIXED_TODAY), date).toEqual([]);
    }
  });

  test.each([
    ['2026-02-30', '存在しない日'],
    ['2026-13-01', '存在しない月'],
    ['2026-1-1', '桁が足りない'],
    ['2026/11/15', '区切りが違う'],
    ['2026-11-15T00:00:00Z', '時刻が付く'],
    ['', '空'],
    ['2062-11-15', '年の打ち間違い（先の年）'],
    ['0000-01-01', '年の打ち間違い（古い年）'],
    ['2025-12-31', '2026-01-01 より前'],
    ['2026-11-17', '検査の日の翌日より後'],
  ])('悪い日付 %s（%s）は落とす', (date) => {
    expect(newsItemProblems({ ...good, date }, FIXED_TODAY), date).not.toEqual([]);
  });
});

describe('newsItemProblems: 題と本文', () => {
  test('題は40字まで、本文は120字まで（コードポイントで数える）', () => {
    expect(NEWS_TITLE_MAX).toBe(40);
    expect(NEWS_BODY_MAX).toBe(120);
    expect(newsItemProblems({ ...good, title: 'あ'.repeat(40), body: 'い'.repeat(120) }, FIXED_TODAY)).toEqual([]);
    // サロゲートペアの文字は1字と数える
    expect(newsItemProblems({ ...good, title: '𠮷'.repeat(40) }, FIXED_TODAY)).toEqual([]);
    expect(newsItemProblems({ ...good, body: '𠮷'.repeat(120) }, FIXED_TODAY)).toEqual([]);
    expect(newsItemProblems({ ...good, body: '𠮷'.repeat(121) }, FIXED_TODAY)).not.toEqual([]);
    expect(newsItemProblems({ ...good, title: 'あ'.repeat(41) }, FIXED_TODAY)).not.toEqual([]);
    expect(newsItemProblems({ ...good, body: 'い'.repeat(121) }, FIXED_TODAY)).not.toEqual([]);
  });

  test.each([
    ['題が空', { title: '' }],
    ['題が空白だけ', { title: '  　 ' }],
    ['題が2行', { title: '一行目\n二行目' }],
    ['題が U+2028 で2行', { title: '一行目\u{2028}二行目' }],
    ['題が U+2029 で2行', { title: '一行目\u{2029}二行目' }],
    ['題が U+0085 で2行', { title: '一行目\u{85}二行目' }],
    ['題がゼロ幅のスペースだけ', { title: '\u{200B}' }],
    ['題が空白とゼロ幅の文字だけ', { title: ' \u{200B}\u{FEFF}\u{2060} ' }],
    ['本文がゼロ幅のスペースだけ', { body: '\u{200B}\u{200B}' }],
    ['本文が空白とゼロ幅の文字だけ', { body: '\u{3000}\u{200B}\n\u{FEFF}' }],
    ['題が長すぎる', { title: 'あ'.repeat(41) }],
    ['本文が空', { body: '' }],
    ['本文が空白だけ', { body: ' \n ' }],
    ['本文が長すぎる', { body: 'い'.repeat(121) }],
  ])('%s は落とす', (_name, override) => {
    expect(newsItemProblems({ ...good, ...override }, FIXED_TODAY)).not.toEqual([]);
  });
});

describe('newsItemProblems と isNewsHref: リンク', () => {
  test('リンクは任意（無くてよい）', () => {
    expect(newsItemProblems(good, FIXED_TODAY)).toEqual([]);
  });

  test('良いリンクは通る', () => {
    for (const href of ['https://example.com/a', 'https://example.com/', 'https://example.com/a?b=1#c']) {
      expect(isNewsHref(href), href).toBe(true);
      expect(newsItemProblems({ ...good, href }, FIXED_TODAY), href).toEqual([]);
    }
  });

  test.each([
    'javascript:alert(1)',
    'http://example.com',
    '//example.com',
    'https://',
    'https://u:p@example.com',
    '',
    'https:///evil.example/x',
    'https://:@example.com',
    'https://example.com/ a',
    'https://example.com',
    'HTTPS://example.com/a',
    'data:text/html,x',
  ])('悪いリンク %j は落とす', (href) => {
    expect(isNewsHref(href), href).toBe(false);
    expect(newsItemProblems({ ...good, href }, FIXED_TODAY), href).not.toEqual([]);
  });
});

describe('latestNews', () => {
  test('日付の新しい順に並べる。一覧の書いた順に依らない', () => {
    const items = [item('2026-10-01'), item('2026-11-15'), item('2026-10-20')];
    expect(latestNews(items).map((news) => news.date)).toEqual(['2026-11-15', '2026-10-20', '2026-10-01']);
  });

  test('同じ日付は、一覧に書いた順のまま', () => {
    const items = [item('2026-11-01', 'あ'), item('2026-11-01', 'い'), item('2026-11-01', 'う')];
    expect(latestNews(items).map((news) => news.title)).toEqual(['あ', 'い', 'う']);
  });

  test('5件までにし、それより古いものは出さない', () => {
    expect(NEWS_LIMIT).toBe(5);
    const items = [
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ].map((date) => item(date));
    expect(latestNews(items).map((news) => news.date)).toEqual([
      '2026-07-01',
      '2026-06-01',
      '2026-05-01',
      '2026-04-01',
      '2026-03-01',
    ]);
  });

  test('5件に満たなければあるだけ。1件も無ければ空（面を置かない）', () => {
    expect(latestNews([item('2026-11-01')])).toHaveLength(1);
    expect(latestNews([])).toEqual([]);
  });

  test('渡した一覧を並べ替えて書き換えない', () => {
    const items = [item('2026-10-01'), item('2026-11-15')];
    latestNews(items);
    expect(items.map((news) => news.date)).toEqual(['2026-10-01', '2026-11-15']);
  });

  test('引数なしは、書いた一覧から出す', () => {
    expect(latestNews()).toEqual(latestNews(newsItems));
  });
});
