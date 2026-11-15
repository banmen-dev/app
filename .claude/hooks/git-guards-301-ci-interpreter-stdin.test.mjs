// #301: PR #1231 の AI レビュー指摘を独立に固定する回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '301-shell-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

// zsh の (N) は一致しない語を消すので、インタープリタは標準入力のコードを実行する。
for (const [tool, body] of [
  ['python3', "print(open('.dev.vars').read())"],
  ['python', "open('.dev.vars')"],
  ['ruby', "File.read('.dev.vars')"],
  ['perl', "open(F, '.dev.vars')"],
  ['php', "<?php file_get_contents('.dev.vars'); ?>"],
]) {
  for (const middle of ['nope(N) ', '']) {
    const command = `${tool} ${middle}<<< "${body}"`;
    test(`[インタープリタの stdin ${tool}] ${middle || 'glob 無し'}`, () => {
      assert.equal(decision(command), 'deny', command);
    });
  }
}

test('[データを読む通常の道具] 空の glob と stderr は通す', () => {
  assert.equal(decision('ls *(N) 2>/dev/null'), 'allow');
});
