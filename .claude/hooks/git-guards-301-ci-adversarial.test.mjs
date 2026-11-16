// #301: CI の修正に対する独立した崩す確認の第1巡。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// Bash の extglob は既存の @/+ を保ち、選択肢が1つでも照合する。
// -O extglob を明示し、シェルの既定オプションに期待しない。
for (const [body, expected] of [
  ['cat < .en@(v|x)', 'deny'],
  ['cat < .en+(v|x)', 'deny'],
  ['cat < .en@(v)', 'deny'],
  ['echo x > .dev.var@(s|z)', 'deny'],
  ['echo x > wrangler.js@(onc|on)', 'ask'],
  ['echo x > wrangler.js+(onc|on)', 'ask'],
  ['echo x > wrangler.js@(onc)', 'ask'],
  ['echo x > report@(txt|log)', 'allow'],
  ['echo x > report+(txt|log)', 'allow'],
]) {
  test(`[Bash extglob の演算子] ${body}`, () => {
    assert.equal(decision(`bash -O extglob -c '${body}'`), expected);
  });
}

test('[zsh の入れ子と修飾子] 選択肢の後ろの N で保護を落とさない', () => {
  assert.equal(decision('echo x > .en((v|x)|y)(N)'), 'deny');
});

test('[行継続で作る EOF)] 論理行の終端でも後続の本番操作を拒否する', () => {
  assert.equal(decision('x="$(cat <<EOF\nhi\nEO\\\nF)"; wrangler deploy\nEOF\n)"'), 'deny');
});

test('[for の算術コマンド] シフトの後ろの本番操作を隠さない', () => {
  assert.equal(decision('x="$(for ((y=1<<2;y<3;y++)); do echo safe; done)"; wrangler deploy'), 'deny');
});

test('[nullglob と zsh の一時ファイル] インタープリタへ渡る入力を確認する', () => {
  assert.equal(decision('python3 nope(N) < =(echo harmless)'), 'ask');
});
