// 導入画面の入力検証とサーバーの操作定義が共有する。操作の束には含めない。
import { z } from 'zod';
import './zod-config.ts';
import { shortTextProblem } from './text-rules.ts';

export const accountProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .refine((value) => value.isWellFormed())
    .superRefine((value, ctx) => {
      if (shortTextProblem(value, 100) !== null) ctx.addIssue({ code: 'custom', message: '表示する名前が使えない' });
    }),
  title: z
    .string()
    .trim()
    .refine((value) => value.isWellFormed())
    .superRefine((value, ctx) => {
      if (value !== '' && shortTextProblem(value, 100) !== null)
        ctx.addIssue({ code: 'custom', message: '肩書きが使えない' });
    }),
});
