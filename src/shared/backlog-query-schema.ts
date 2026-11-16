// APIとWiki画面の入力検証。最初の画面の検索補助から分け、検証が必要なときだけ読む。
import { z } from 'zod';
import './zod-config.ts';
import { BACKLOG_QUERY_MAX_LENGTH, backlogQueryProblem } from './backlog-filter.ts';

// 前後の空白を外した検索の文字。空なら検索しない（前後の空白を除く前に、桁違いに長い値を止める）
export const backlogQuerySchema = z
  .string()
  .max(BACKLOG_QUERY_MAX_LENGTH * 10)
  .trim()
  .superRefine((query, ctx) => {
    const problem = backlogQueryProblem(query);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `検索の文字が使えない（${problem}）` });
  });
