// #301: PR #1231 の AI レビュー指摘を独立に固定する回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '301-shell-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

for (const [label, command] of [
  ['brace の展開数超過', 'echo x > report-{1..10000}.log'],
  ['名前の長さ超過', 'echo x > ' + 'x'.repeat(5000) + '?'],
]) {
  test(`[ASK の理由は文字列] ${label}`, () => {
    const result = judgeBash(command, context);
    assert.equal(result?.[0], 'ask');
    assert.equal(typeof result?.[1], 'string');
    assert.ok(result[1].length > 0);
  });
}

test('[DENY の理由の対照] シークレットは理由付きで拒否する', () => {
  const result = judgeBash('echo x > .dev.vars{1..10000}', context);
  assert.equal(result?.[0], 'deny');
  assert.equal(typeof result?.[1], 'string');
});
