import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DYNAMIC, expandsAt, replaceWord, shapeAt, splitSegments, substitutionsAt } from './shell-words.mjs';

describe('#1247 replaceWord の差し込み文字列と印', () => {
  for (const literal of ['$&', '$$', '$`', "$'"]) {
    test(`${literal} は JavaScript の置換記号として展開しない`, () => {
      const words = replaceWord(splitSegments('cat before{}after{}tail')[0], 1, '{}', literal);
      assert.equal(words[0], `before${literal}after${literal}tail`);
      const replacementShape = literal === '$$' ? DYNAMIC + DYNAMIC : DYNAMIC + literal.slice(1);
      assert.equal(shapeAt(words, 0), `before${replacementShape}after${replacementShape}tail`);
      assert.equal(expandsAt(words, 0), true);
      assert.deepEqual(substitutionsAt(words, 0), []);
    });
  }

  test('起点 descriptor と元の引数の置換の印をともに保つ', () => {
    const origin = { target: '$(…)', shape: DYNAMIC, expands: true, substitutions: ['echo .env'] };
    const words = replaceWord(splitSegments('cat "$(mktemp)/{}"')[0], 1, '{}', origin);
    assert.equal(words[0], '$(…)/$(…)');
    assert.equal(shapeAt(words, 0), `${DYNAMIC}/${DYNAMIC}`);
    assert.equal(expandsAt(words, 0), true);
    assert.deepEqual(substitutionsAt(words, 0), ['mktemp', 'echo .env']);
  });
});
