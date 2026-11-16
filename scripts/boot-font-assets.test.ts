import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('共通フォントの原本と生成物のハッシュが一致し、転送を減らす', () => {
  const manifest = JSON.parse(readFileSync(new URL('../design/fonts/manifest.json', import.meta.url), 'utf8')) as {
    fontsourceVersion: string;
    fonts: { file: string; sourceSha256: string; sha256: string }[];
  };
  const fontsource = new URL('../node_modules/@fontsource-variable/noto-sans-jp/', import.meta.url);
  assert.equal(
    manifest.fontsourceVersion,
    JSON.parse(readFileSync(new URL('package.json', fontsource), 'utf8')).version,
  );
  assert.deepEqual(
    manifest.fonts.map((font) => font.file),
    [
      ...Array.from({ length: 11 }, (_, index) => `noto-sans-jp-${109 + index}-wght-normal.woff2`),
      'noto-sans-jp-latin-wght-normal.woff2',
    ],
  );
  let sourceBytes = 0;
  let optimizedBytes = 0;
  for (const { file, sourceSha256, sha256 } of manifest.fonts) {
    const source = readFileSync(new URL(`files/${file}`, fontsource));
    const output = readFileSync(new URL(`../design/fonts/${file}`, import.meta.url));
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      sourceSha256,
      `${file}: 原本の更新後は再生成が必要`,
    );
    assert.equal(createHash('sha256').update(output).digest('hex'), sha256, `${file}: 生成物が変わった`);
    assert.equal(output.toString('ascii', 0, 4), 'wOF2');
    assert.ok(output.length <= source.length, file);
    sourceBytes += source.length;
    optimizedBytes += output.length;
  }
  assert.ok(optimizedBytes < sourceBytes);
});
