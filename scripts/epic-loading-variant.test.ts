import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { epicLoadingSource } from './epic-loading-variant.ts';

const source = readFileSync(new URL('../src/routes/[slug]/w/[id]/epics/[epicId]/+page.ts', import.meta.url), 'utf8');

test('A は現行の load を使い、B は同じ順序で両方開始し主だけを待つ', () => {
  assert.equal(epicLoadingSource(source, 'A'), source);
  const variant = epicLoadingSource(source, 'B');
  assert.match(
    variant,
    /const primaryRead = callOperation\(epicDetail.*\n\s+const definitions = callOperation\(categoryRepositoryList.*\n\s+const result = await primaryRead;/,
  );
  assert.match(variant, /\n\s+definitions,/);
  assert.doesNotMatch(variant, /Promise\.all/);
});

test('C は未使用の通信のみを外し、認証と再取得の流れを保つ', () => {
  const variant = epicLoadingSource(source, 'C');
  assert.doesNotMatch(variant, /categoryRepositoryList|definitions\s*:/);
  assert.match(variant, /await callOperation\(epicDetail/);
  assert.match(variant, /depends\('app:epic-detail'\)/);
  assert.match(variant, /redirect\(307, loginUrl\(url\)\)/);
  assert.throws(() => epicLoadingSource(source.replace('Promise.all', 'Promise.race'), 'C'), /load が変わりました/);
});
