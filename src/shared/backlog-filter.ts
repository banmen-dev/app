// バックログの絞り込みと検索の共通の決まり（docs/requirements.md の「絞り込みと検索」）。backlog-tree の入力の検証と、
// 画面の検索の欄が同じ判定を使う。画面の束にも入り、scripts/ からも読むので、Node の型の除去で動く書き方に留める

// 検索の文字は、前後の空白を除いて 100 字まで（コードポイントで数える）、語は 5 つまで
export const BACKLOG_QUERY_MAX_LENGTH = 100;
export const BACKLOG_QUERY_MAX_WORDS = 5;

// 検索の文字を語に分ける。半角と全角の空白（ほかの空白の文字も。\s は全角の空白 U+3000 を含む）で区切り、空の語は捨てる
export function searchWordsOf(query: string): string[] {
  return query.split(/\s+/u).filter((word) => word !== '');
}

export type BacklogQueryProblem = 'too_long' | 'too_many_words';

// query は前後の空白を除いた後の値
export function backlogQueryProblem(query: string): BacklogQueryProblem | null {
  if ([...query].length > BACKLOG_QUERY_MAX_LENGTH) return 'too_long';
  const words = searchWordsOf(query);
  if (words.length > BACKLOG_QUERY_MAX_WORDS) return 'too_many_words';
  return null;
}
