import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { designFontsDir, dropWoff, fontAssetUrl, fontsourceWoff2Only } from './fontsource-woff2.ts';

const face = `@font-face {
  font-family: 'Noto Sans JP';
  font-weight: 400;
  src: url(./files/noto-sans-jp-0-400-normal.woff2) format('woff2'), url(./files/noto-sans-jp-0-400-normal.woff) format('woff');
  unicode-range: U+25ee8,U+25f23;
}`;

describe('fontsource の woff を外す', () => {
  test('空白・括弧・引用符を含む作業場所でも有効な CSS の URL にする', () => {
    assert.equal(fontAssetUrl('C:\\My Project (ui)\\font"name.woff2'), 'url("C:/My Project (ui)/font\\"name.woff2")');
  });
  test('src から woff だけを外し、woff2 と unicode-range を残す', () => {
    const out = dropWoff(face);
    assert.match(out, /src: url\(\.\/files\/noto-sans-jp-0-400-normal\.woff2\) format\('woff2'\);/);
    assert.doesNotMatch(out, /\.woff\)/);
    assert.match(out, /unicode-range: U\+25ee8,U\+25f23;/);
  });

  test('可変版は全ての文字範囲と太さを保ち、共通の書体名で配る', () => {
    const css = readFileSync(
      new URL('../node_modules/@fontsource-variable/noto-sans-jp/index.css', import.meta.url),
      'utf8',
    );
    const transform = fontsourceWoff2Only().transform as (code: string, id: string) => { code: string } | null;
    const out = transform(css, '/repo/node_modules/@fontsource-variable/noto-sans-jp/index.css?direct')!.code;
    const faces = out.match(/@font-face\s*\{[^}]+\}/g)!;
    assert.equal(faces.length, 124);
    for (const face of faces) {
      assert.match(face, /font-family: 'Noto Sans JP';/);
      assert.match(face, /font-weight: 100 900;/);
      assert.match(face, /font-display: swap;/);
      assert.match(face, /\.woff2"?\) format\('woff2-variations'\)/);
      assert.match(face, /unicode-range: U\+/);
    }
    assert.deepEqual(out.match(/unicode-range:[^;]+;/g), css.match(/unicode-range:[^;]+;/g));
    // 共通の日本語と Latin は横書き用の生成物へ向ける。ほかの文字範囲は元のまま。
    assert.equal((out.match(/design\/fonts\/noto-sans-jp-/g) ?? []).length, 12);
    assert.deepEqual(
      [...out.matchAll(/noto-sans-jp-([\w-]+)\.woff2/g)].map((m) => m[1]),
      [...css.matchAll(/noto-sans-jp-([\w-]+)\.woff2/g)].map((m) => m[1]),
    );
    assert.doesNotMatch(out, /Noto Sans JP Variable|\.woff\)/);
    // 別の可変書体を誤って同じ名前へ変えない。
    assert.equal(transform(css, '/repo/node_modules/@fontsource-variable/other/index.css'), null);
  });

  test('置き換え先の design/fonts を dev で配る範囲に足し、置き換えた URL はその中を指す', () => {
    const plugin = fontsourceWoff2Only();
    const config = (plugin.config as () => { server: { fs: { allow: string[] } } })();
    assert.deepEqual(config.server.fs.allow, [designFontsDir]);
    assert.ok(existsSync(designFontsDir));
    const css = readFileSync(
      new URL('../node_modules/@fontsource-variable/noto-sans-jp/index.css', import.meta.url),
      'utf8',
    );
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    const out = transform(css, '/repo/node_modules/@fontsource-variable/noto-sans-jp/index.css')!.code;
    const replaced = [...out.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.equal(replaced.length, 12);
    const allowed = designFontsDir.replaceAll('\\', '/');
    for (const file of replaced) {
      assert.ok(file.startsWith(allowed), file);
      assert.ok(existsSync(file), file);
    }
  });

  test('可変版の書体名が変わったら黙って代替書体にせず停止する', () => {
    const transform = fontsourceWoff2Only().transform as (code: string, id: string) => { code: string } | null;
    for (const css of ["@font-face { font-family: 'Renamed'; }", '@font-face { font-weight: 100 900; }']) {
      assert.throws(
        () => transform(css, '/repo/node_modules/@fontsource-variable/noto-sans-jp/index.css'),
        /Noto Sans JP/,
      );
    }
  });

  test('引用符と空白が異なっても正常な書体名をそろえ、異なる書体との混在は断る', () => {
    const transform = fontsourceWoff2Only().transform as (code: string, id: string) => { code: string } | null;
    const id = '/repo/node_modules/@fontsource-variable/noto-sans-jp/index.css';
    for (const quote of ["'", '"']) {
      const css = `@font-face { font-family: ${quote}Noto Sans JP Variable${quote}  ; }`;
      const normalized = transform(css, id)!.code;
      assert.match(normalized, /font-family: 'Noto Sans JP';/);
      assert.doesNotMatch(normalized, /Variable/);
      assert.throws(() => transform(`${css} @font-face { font-family: 'Other'; }`, id), /Noto Sans JP/);
    }
  });

  test('プラグインは @fontsource の CSS だけを書き換える', () => {
    const plugin = fontsourceWoff2Only();
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    assert.equal(
      transform.call({}, face, '/repo/node_modules/@fontsource/noto-sans-jp/400.css')?.code.includes('.woff)'),
      false,
    );
    assert.equal(transform.call({}, face, '/repo/design/components.css'), null);
    assert.equal(transform.call({}, face, '/repo/node_modules/@fontsource/noto-sans-jp/index.js'), null);
  });
});
