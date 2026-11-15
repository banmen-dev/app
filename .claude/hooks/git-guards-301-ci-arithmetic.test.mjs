// #301: PR #1231 の AI レビュー指摘を独立に固定する回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '301-shell-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

// 算術コマンドの << はビットシフトで、heredoc の開始ではない。
for (const [command, expected] of [
  ['x="$( (( y = 1 << 2 ))\necho hi\n)"; wrangler deploy', 'deny'],
  ['x="$( (( y = 1 << 2 ))\necho hi\n)"; cat .dev.vars', 'deny'],
  ['x="$( (( y = 1 << 2 ))\necho hi\n)"; echo x > wrangler.jsonc', 'ask'],
  ['x="$( (( y = 1 << 2 ))\necho hi\n)"; echo harmless', 'allow'],
  ['x="$( (( y = 8 >> 1 ))\necho hi\n)"; echo harmless', 'allow'],
]) {
  test(`[置換内の算術コマンド] ${JSON.stringify(command)}`, () => {
    assert.equal(decision(command), expected, command);
  });
}
