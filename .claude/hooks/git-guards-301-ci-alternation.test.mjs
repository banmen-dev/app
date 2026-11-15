// #301: PR #1231 の AI レビュー指摘を独立に固定する回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '301-shell-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

// zsh の (a|b) は (N) のような修飾子ではなく、名前の選択肢になる。
for (const [command, expected] of [
  ['cat < .en(v|x)', 'deny'],
  ['echo x > .dev.var(s|z)', 'deny'],
  ['echo x > wrangler.js(onc|on)', 'ask'],
  ['echo x > .en(x|y)', 'allow'],
  ['echo x > report.(txt|log)', 'allow'],
  ['echo x > ".en(v|x)"', 'allow'],
]) {
  test(`[リダイレクト先の選択肢] ${command}`, () => {
    assert.equal(decision(command), expected, command);
  });
}

// .*.log は .env.log に一致し、.env.log は従来からシークレットなので拒否を維持する。
for (const command of ['echo x > .*.log', 'echo x > .env.log']) {
  test(`[環境別シークレットの対照] ${command}`, () => {
    assert.equal(decision(command), 'deny', command);
  });
}
