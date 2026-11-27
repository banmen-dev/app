// 組織のホームの「Banmen のニュース」の面に出す知らせ。リポジトリに置き、リリースで配る（API と DB は通さない）。
// どの組織のホームでも同じ一覧が出る。足し方は docs/development.md の「ニュースの足し方」
import { stripHiddenCharacters } from '../shared/hidden-characters.ts';

export type NewsItem = {
  // 知らせた日。タイムゾーンを持たない YYYY-MM-DD（暦の日付の記録なので、ブラウザのタイムゾーンで直さず、そのまま出す）
  date: string;
  // 題。空でない1行（40字まで）。書いたまま出す（辞書を通さない）
  title: string;
  // 本文。空でない短い平文（120字まで）。書いたまま出す（Markdown にしない）
  body: string;
  // 詳しく読める先。任意。`https://` で始まり、正規化しても形が変わらないものだけ（isNewsHref）。新しいタブで開く
  href?: string;
};

// 面に出す件数の上限。新しい順に並べて、これより古いものは出さない（design/kit.js の newsList の slice も同じ値）
export const NEWS_LIMIT = 5;

// 一覧の形の決まり（newsItemProblems が見る）。日付は NEWS_FIRST_DATE 以上で、検査を走らせた日の翌日まで（年の打ち間違いで先頭に居座らないように）。
// 題と本文の長さはコードポイントで数える。狭い幅で題が何行にも折り返して、左の列が伸びないようにする
export const NEWS_FIRST_DATE = '2026-01-01';
export const NEWS_TITLE_MAX = 40;
export const NEWS_BODY_MAX = 120;

// 実在する暦の日付（YYYY-MM-DD）か。2026-02-30 のような存在しない日は偽
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

// リンクとして出してよい URL か。`https://` で始まり、URL として読め、正規化しても形が変わらず（`https://example.com` は
// `https://example.com/` になるので末尾の / まで書く）、ユーザー情報を持たないものだけ。画面（NewsPane）も同じ関数で見る
export function isNewsHref(href: string): boolean {
  if (!href.startsWith('https://')) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.href === href && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

// 空白と見えない文字（ゼロ幅のスペースなど。src/shared/hidden-characters.ts の判定）だけなら真。名前の正規化の「空」と同じ扱い
function isBlank(value: string): boolean {
  return stripHiddenCharacters(value).trim() === '';
}

// 1件の形の問題を日本語の文で返す（問題が無ければ空）。today は検査を走らせた日の YYYY-MM-DD（日付の上限は翌日）
export function newsItemProblems(item: NewsItem, today: string): string[] {
  const problems: string[] = [];
  if (!isCalendarDate(item.date)) {
    problems.push(`日付が実在する YYYY-MM-DD ではない: ${item.date}`);
  } else {
    const last = new Date(Date.parse(`${today}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (item.date < NEWS_FIRST_DATE) problems.push(`日付が ${NEWS_FIRST_DATE} より前: ${item.date}`);
    if (item.date > last) problems.push(`日付が ${last}（検査の日の翌日）より後: ${item.date}`);
  }
  if (isBlank(item.title)) problems.push('題が空');
  if (/[\r\n\u{85}\u{2028}\u{2029}]/u.test(item.title)) problems.push('題が1行ではない');
  if ([...item.title].length > NEWS_TITLE_MAX) problems.push(`題が ${NEWS_TITLE_MAX} 字を超える`);
  if (isBlank(item.body)) problems.push('本文が空');
  if ([...item.body].length > NEWS_BODY_MAX) problems.push(`本文が ${NEWS_BODY_MAX} 字を超える`);
  if (item.href !== undefined && !isNewsHref(item.href)) problems.push(`リンクが使えない形: ${item.href}`);
  return problems;
}

// 新しいものを先に書く必要は無い（出すときに日付の新しい順に並べる）が、読みやすいので新しい順に足す
export const newsItems: readonly NewsItem[] = [
  {
    date: '2026-11-22',
    title: 'サービスの名前を Banmen に改めました',
    body: 'Scrum Guild から Banmen に改めました。使い方とデータは変わりません。',
  },
  {
    date: '2026-11-15',
    title: '組織のホームがダッシュボードになりました',
    body: '今日やることを先頭に、ワークスペースと最近の更新を右の列に並べました。ここには Banmen からの知らせが載ります。',
  },
];

// 日付の新しい順に、NEWS_LIMIT 件まで。同じ日付は一覧に書いた順のまま。空なら空を返し、面は置かない
export function latestNews(items: readonly NewsItem[] = newsItems): NewsItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.date < b.item.date ? 1 : a.item.date > b.item.date ? -1 : a.index - b.index))
    .slice(0, NEWS_LIMIT)
    .map(({ item }) => item);
}
