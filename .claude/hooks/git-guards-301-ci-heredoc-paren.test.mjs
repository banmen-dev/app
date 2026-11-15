// #301: PR #1231 の AI レビュー指摘を独立に固定する回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '301-shell-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

// Bash は EOF) で置換を閉じうるが、zsh は終端行全体の一致を求める。
// 危険なコマンドが Bash で実行される形は拒否し、安全でもシェル間で割れる構文は確認する。
for (const delimiter of ['EOF', "'EOF'"]) {
  const command = `x="$(cat <<${delimiter}\nhi\nEOF)"; wrangler deploy\nEOF\n)"`;
  test(`[Bash が実行する EOF) ${delimiter}] 本番操作を拒否する`, () => {
    assert.equal(decision(command), 'deny', command);
  });
}

test('[Bash/zsh の EOF) の差] 危険な操作が無くても確認する', () => {
  assert.equal(decision('x="$(cat <<EOF\nhi\nEOF)"'), 'ask');
});

test('[通常の終端] 正しい独立行の EOF と安全な操作を通す', () => {
  assert.equal(decision('x="$(cat <<EOF\nhi\nEOF\n)"; echo harmless'), 'allow');
});
