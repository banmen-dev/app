import { previewAlias } from './preview-cloudflare.ts';

// ビルドの入口と配信で同じ Issue 番号を使う。alias と Worker 名を合わせて 63 文字まで。
export function previewBranchNumber(branch: string): string | undefined {
  const match = /^([1-9][0-9]*)-[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.exec(branch);
  if (!match || match[0] !== branch) return undefined;
  const number = match[1];
  return previewAlias(number).length <= 63 ? number : undefined;
}
