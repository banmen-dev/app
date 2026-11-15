import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';
import { DYNAMIC, replaceWord, shapeAt, splitSegments } from './shell-words.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '1247-secret-substitution' })?.[0] ?? 'allow';

describe('#1247 find の起点と実行する引数の組み合わせ', () => {
  for (const [command, expected] of [
    ['find -f "$(echo .env)" -exec cat {} \\;', 'deny'],
    ['find docs "$(echo .env)" -exec cat {} +', 'deny'],
    ['find "$(echo /tmp/.env)" -execdir head {} \\;', 'deny'],
    ['find "$(echo .en)v" -execdir cp {} /tmp/copy \\;', 'deny'],
    ['find "$(echo .env)" -exec cp -t /tmp {} +', 'deny'],
    ['find "$(echo .env)" -exec cat "$(mktemp)/{}" \\;', 'deny'],
    ['find "$(mktemp -d)/out.log" -execdir cat {} \\;', 'allow'],
    ['find "$(echo .env)" -exec grep {} docs \\;', 'allow'],
  ]) {
    test(`${command} は ${expected}`, () => assert.equal(decision(command), expected, command));
  }

  test('文字列で差し込む起点の変数も shape に展開の位置を残す', () => {
    const words = replaceWord(splitSegments('cat {}')[0], 1, '{}', '$ROOT');
    assert.ok(shapeAt(words, 0).includes(DYNAMIC));
  });
});
