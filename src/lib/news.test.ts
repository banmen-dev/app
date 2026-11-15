import { describe, expect, test } from 'vitest';
import { NEWS_LIMIT, latestNews, newsItems, type NewsItem } from './news.ts';

const item = (date: string, title = `題 ${date}`): NewsItem => ({ date, title, body: '本文' });

// 実在の暦の日付か（2026-02-30 のような存在しない日を弾く）
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

describe('ニュースの一覧（src/lib/news.ts に書いたもの）の形', () => {
  test('1件以上ある', () => {
    expect(newsItems.length).toBeGreaterThan(0);
  });

  test('日付は実在する YYYY-MM-DD', () => {
    for (const news of newsItems) expect(isCalendarDate(news.date), news.date).toBe(true);
  });

  test('題と本文は空でない（空白だけも不可）。題は1行', () => {
    for (const news of newsItems) {
      expect(news.title.trim(), `${news.date} の題`).not.toBe('');
      expect(news.body.trim(), `${news.date} の本文`).not.toBe('');
      expect(news.title, `${news.date} の題`).not.toMatch(/[\r\n]/);
    }
  });

  test('リンクは https:// で始まり、URL として読め、ユーザー情報を含まない', () => {
    for (const news of newsItems) {
      if (news.href === undefined) continue;
      expect(news.href.startsWith('https://'), news.href).toBe(true);
      const url = new URL(news.href);
      expect(url.protocol).toBe('https:');
      expect(url.username + url.password, news.href).toBe('');
    }
  });

  test('同じ日付と題の組は重ならない', () => {
    const keys = newsItems.map((news) => `${news.date}\n${news.title}`);
    expect(new Set(keys).size).toBe(keys.length);
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
    expect(latestNews()).toEqual(latestNews(newsItems, NEWS_LIMIT));
  });
});
