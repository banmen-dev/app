// #301: CI 修正後の独立した崩す確認の第2巡。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// 反復・省略・否定の演算子も、先頭の @ と取り違えず元の意味で照合する。
for (const [body, expected] of [
  ['cat < .en*(v)', 'deny'],
  ['cat < .en?(v)', 'deny'],
  ['cat < .en!(x)', 'deny'],
  ['echo x > wrangler.jso!(x)', 'ask'],
  ['cat < .en?(@(v))', 'deny'],
  ['cat < .en!(@(x))', 'deny'],
]) {
  test(`[Bash extglob の反復・省略・否定] ${body}`, () => {
    assert.equal(decision(`bash -O extglob -c '${body}'`), expected);
  });
}

// 選択肢の内側で引用した | は区切りではなく名前の一部になる。
for (const [command, expected] of [
  ['cat < .en(v|"x|y")', 'deny'],
  ['echo x > report("a|b"|c)', 'allow'],
]) {
  test(`[選択肢内の引用 pipe] ${command}`, () => {
    assert.equal(decision(command), expected);
  });
}

test('[Bash の終端 prefix と空白] EOF の後ろに空白があっても危険な後続を拒否する', () => {
  assert.equal(decision('x="$(cat <<EOF\nhi\nEOF )"; wrangler deploy\nEOF\n)"'), 'deny');
});

test('[終端 prefix でない本文] 別の名前と閉じ括弧の行は本文のままにする', () => {
  assert.equal(decision('x="$(cat <<EOF\nhi\nOTHER)"; wrangler deploy\nEOF\n)"'), 'allow');
});
