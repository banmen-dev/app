import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import type { NewsItem } from '../news.ts';
import NewsPane from './NewsPane.svelte';

const plain: NewsItem = { date: '2026-11-15', title: '架空の知らせ', body: '架空の本文です。' };
const linked: NewsItem = {
  date: '2026-11-01',
  title: '架空のリンク付きの知らせ',
  body: '詳しくはリンクから。',
  href: 'https://example.com/news/sample',
};

test('一覧が空なら、面を置かない', () => {
  const { body } = render(NewsPane, { props: { items: [] } });
  expect(body).not.toContain('pane');
  expect(body).not.toContain('Scrum Guild のニュース');
});

test('面の見出しは h2 で、日付と題と本文を一覧の順に出す', () => {
  const { body } = render(NewsPane, { props: { items: [plain, linked] } });
  expect(body).toMatch(/<h2[^>]*>Scrum Guild のニュース<\/h2>/);
  expect(body).toContain('<time class="news-date" datetime="2026-11-15">2026-11-15</time>');
  expect(body.indexOf('架空の知らせ')).toBeLessThan(body.indexOf('架空のリンク付きの知らせ'));
  expect(body).toContain('架空の本文です。');
});

test('リンクの無い知らせの題は、リンクにしない', () => {
  const { body } = render(NewsPane, { props: { items: [plain] } });
  expect(body).not.toContain('<a');
  expect(body).toContain('<b class="news-title">架空の知らせ</b>');
});

test('リンクのある知らせの題は、新しいタブで開き、external の印と読み上げの補足を添える', () => {
  const { body } = render(NewsPane, { props: { items: [linked] } });
  expect(body).toContain('href="https://example.com/news/sample"');
  expect(body).toContain('target="_blank"');
  expect(body).toContain('rel="external noopener noreferrer"');
  expect(body).toContain('#i-external');
  expect(body).toContain('新しいタブで開きます');
});

test('題と本文は書いたまま出す（HTML として解釈しない）', () => {
  const { body } = render(NewsPane, {
    props: { items: [{ date: '2026-11-15', title: '<i>題</i>', body: '<script>alert(1)</script>' }] },
  });
  expect(body).not.toContain('<script>');
  expect(body).not.toContain('<i>題</i>');
  expect(body).toContain('&lt;i>題&lt;/i>');
});
