import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { DESIGN_RULE_HEADINGS, extractDesignRules, extractDesignSection } from './screen-review-design.ts';

describe('採点役に渡す設計文書の抜粋', () => {
  test('実物の docs/design.md から2節が抜ける', () => {
    const { headings, text } = extractDesignRules(readFileSync(new URL('../docs/design.md', import.meta.url), 'utf8'));
    assert.deepEqual(headings, [...DESIGN_RULE_HEADINGS]);
    for (const heading of DESIGN_RULE_HEADINGS)
      assert.ok(text.includes(`\n${heading}\n`) || text.startsWith(`${heading}\n`));
    assert.ok(!text.includes('## 文字サイズ'));
    assert.ok(!text.includes('### テーマごとの違い'));
    // 節ごとの最後の項目まで入っている（途中で切れていない）
    assert.ok(text.includes('6. **言葉が長くなっても崩れない。**'));
    assert.ok(text.includes('**演出・面の出現と行の合図:**'));
    // 見出しから次の見出しまでを別の方法で切り出した全文と一致する
    const source = readFileSync(new URL('../docs/design.md', import.meta.url), 'utf8');
    const slice = (from: string, to: string) =>
      source.slice(source.indexOf(`\n${from}\n`) + 1, source.indexOf(`\n${to}\n`) + 1);
    assert.equal(
      text,
      `${slice('## デザイン原則', '## 文字サイズ').trimEnd()}\n\n${slice('### どのテーマにも共通すること', '### テーマごとの違い').trimEnd()}\n`,
    );
  });

  test('コードフェンスの中の # は見出しにしない', () => {
    const md = '## A\nx\n```sh\n# comment\n## A\n```\ny\n## B\nb\n';
    assert.equal(extractDesignSection(md, '## A'), '## A\nx\n```sh\n# comment\n## A\n```\ny\n');
  });

  test('CRLF、末尾の空白、ファイル末尾までの節を扱う', () => {
    assert.equal(extractDesignSection('## A \r\nx\r\n## B\r\n', '## A'), '## A \nx\n');
    assert.equal(extractDesignSection('## B\nb\n## A\nx\n', '## A'), '## A\nx\n');
  });

  test('節は同じ深さか浅い次の見出しで終わり、深い見出しは含む', () => {
    const md = '## A\n本文\n### 子\n子の本文\n#### 孫\n## B\n別\n';
    assert.equal(extractDesignSection(md, '## A'), '## A\n本文\n### 子\n子の本文\n#### 孫\n');
    assert.equal(extractDesignSection('### X\nx\n## Y\ny\n', '### X'), '### X\nx\n');
  });

  test('見出しが無いと、名前を出して例外を投げる', () => {
    assert.throws(() => extractDesignSection('## A\n本文\n', '## B'), /見出し「## B」がありません/);
  });

  test('見出しが重なると例外を投げる', () => {
    assert.throws(() => extractDesignSection('## A\nx\n## A\ny\n', '## A'), /「## A」が2件/);
  });

  test('本文が空だと例外を投げる', () => {
    assert.throws(() => extractDesignSection('## A\n\n## B\nb\n', '## A'), /本文が空/);
  });

  test('見出しは完全一致で、部分一致や深さ違いは拾わない', () => {
    assert.throws(() => extractDesignSection('## デザイン原則（案）\nx\n', '## デザイン原則'), /ありません/);
    assert.throws(() => extractDesignSection('### A\nx\n', '## A'), /ありません/);
  });
});
