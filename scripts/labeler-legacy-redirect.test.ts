// .github/labeler.yml の needs-human の規則が、旧 URL の転送（#1421）のファイルを拾うか。
// 評価の仕方は scripts/labeler.test.ts と同じ（actions/labeler と同じ dot: true の minimatch）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';
import { Minimatch } from 'minimatch';

type Matcher = { 'any-glob-to-any-file'?: string[]; 'all-globs-to-any-file'?: string[] };

const config = load(readFileSync(new URL('../.github/labeler.yml', import.meta.url), 'utf8')) as Record<
  string,
  { 'changed-files': Matcher[] }[]
>;

function needsHuman(path: string): boolean {
  return config['needs-human']!.some((item) =>
    item['changed-files'].some((matcher) => {
      const [key] = Object.keys(matcher);
      const globs = (matcher as Record<string, string[]>)[key!]!.map((g) => new Minimatch(g, { dot: true }));
      if (key === 'any-glob-to-any-file') return globs.some((m) => m.match(path));
      if (key === 'all-globs-to-any-file') return globs.every((m) => m.match(path));
      throw new Error(`評価できない書き方: ${key}`);
    }),
  );
}

describe('崩し: 転送用の Worker のコードは人が差分を読む', () => {
  // docs/development.md「マージの判定」は、デプロイのスクリプトと wrangler の設定を needs-human にする。
  // デプロイのスクリプト（scripts/deploy-legacy-redirect.ts）は、置く前の確かめと置いた後の確かめの宛先
  // （LEGACY_REDIRECT_TARGET）を src/legacy-redirect/worker.ts から読み、人が手元で出すのはこのファイルそのもの。
  // 転送先は招待の URL の断片（<公開 URL>/invite#<秘密>）をブラウザが引き継いで持っていく先でもある（docs/operations.md の「旧 URL の転送」）。
  // needs-human が付かないと、転送先の書き換えを人が読まずにセッションがマージし、当日の人の実行がそのまま出す
  test('src/legacy-redirect/worker.ts を変えた PR に needs-human が付く', () => {
    assert.equal(needsHuman('src/legacy-redirect/worker.ts'), true);
  });
});
