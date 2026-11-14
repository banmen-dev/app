// #301: 独立した崩す担当の最終第3巡。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// 引用した - は文字クラスの範囲演算子ではない。Bash/zsh のどちらも a/-/z だけに一致し、v/n には一致しない。
for (const command of ['echo x > .en[a"-"z]', 'echo x > wrangler.jso[a"-"z]']) {
  test(`[文字クラスの引用したハイフン] ${command}`, () => {
    assert.equal(decision(command), 'allow');
  });
}

// 引用しても通常文字 v は文字クラスの候補に残る。
test('[文字クラスの引用した通常文字] シークレットに当たるなら拒否する', () => {
  assert.equal(decision('echo x > .en["v"]'), 'deny');
});
