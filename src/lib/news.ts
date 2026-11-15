// 組織のホームの「Scrum Guild のニュース」の面に出す知らせ。リポジトリに置き、リリースで配る（API と DB は通さない）。
// どの組織のホームでも同じ一覧が出る。足し方は docs/development.md の「ニュースの足し方」
export type NewsItem = {
  // 知らせた日。タイムゾーンを持たない YYYY-MM-DD
  date: string;
  // 題。空でない1行。書いたまま出す（辞書を通さない）
  title: string;
  // 本文。空でない短い平文。書いたまま出す（Markdown にしない）
  body: string;
  // 詳しく読める先。任意。`https://` で始まるものだけ（新しいタブで開く）
  href?: string;
};

// 面に出す件数の上限。新しい順に並べて、これより古いものは出さない
export const NEWS_LIMIT = 5;

// 新しいものを先に書く必要は無い（出すときに日付の新しい順に並べる）が、読みやすいので新しい順に足す
export const newsItems: readonly NewsItem[] = [
  {
    date: '2026-11-15',
    title: '組織のホームがダッシュボードになりました',
    body: 'ワークスペースと今日やることを左の列に並べました。ここには Scrum Guild からの知らせが載ります。',
  },
];

// 日付の新しい順に、上限の件数まで。同じ日付は一覧に書いた順のまま。空なら空を返し、面は置かない
export function latestNews(items: readonly NewsItem[] = newsItems, limit: number = NEWS_LIMIT): NewsItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.date < b.item.date ? 1 : a.item.date > b.item.date ? -1 : a.index - b.index))
    .slice(0, limit)
    .map(({ item }) => item);
}
