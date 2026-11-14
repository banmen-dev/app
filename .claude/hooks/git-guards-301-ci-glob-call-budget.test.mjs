// #301: 展開後の各パターンが短くても、照合の呼び出し回数を制限する。
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

test('多数の短い brace 展開は照合を打ち切って確認へ回す', () => {
  const original = path.matchesGlob;
  let calls = 0;
  path.matchesGlob = (...args) => {
    calls++;
    return original(...args);
  };
  let result;
  try {
    result = judgeBash('echo x > [.]' + 'x'.repeat(80) + '{1..256}?', {
      cwd: '/repo', branchOf: () => '301-shell-guards',
    });
  } finally {
    path.matchesGlob = original;
  }
  assert.equal(result?.[0], 'ask');
  assert.equal(typeof result?.[1], 'string');
  // 既存の守る先などの照合も含め、数万回の全接頭部走査に戻らない。
  assert.ok(calls < 8192, `matchesGlob が ${calls} 回呼ばれた`);
});
