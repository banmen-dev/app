// #1246 / PR #1251: HIGH 修正の最終反証。継承印の経路と内側のパイプによる置換を確かめる。
// 危険な本文は実行せず、judgeBash の字面判定だけを呼ぶ。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = {
  cwd: '/repo',
  branchOf: () => '1246-piped-script-guard',
  scriptOf: (dir, name) => ({ nested: 'bash', data: 'cat' })[name],
};
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

describe('#1246 CI HIGH 反証3: 追加の再帰経路と fd0 の出どころ', () => {
  for (const command of [
    'cat x.sh | corepack npm exec -c bash',
    'cat x.sh | node --run nested',
    "echo 'wrangler deploy' | bash -c 'bash' 3<<< 'ls'",
    "cat x.sh | bash -c 'bash' 0<&3",
    "echo 'wrangler deploy' | bash -c 'cat x.sh | bash'",
    "echo 'wrangler deploy' | npx --call='bash' 3<<< 'ls'",
    "echo 'wrangler deploy' | bash -c 'bash </dev/stdin'",
  ]) {
    test(`[すり抜け・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
  for (const command of [
    "echo 'wrangler deploy' | node --run data",
    "echo 'wrangler deploy' | bash -c 'echo ls | bash'",
    "bash -c 'bash'",
  ]) {
    test(`[完了条件・通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
  test('[すり抜け・確認] 継承印を運ぶ再帰も既存の深さ上限で止まる', () => {
    let body = 'bash';
    for (let depth = 0; depth < 8; depth++) body = `eval ${JSON.stringify(body)}`;
    assert.deepEqual(judgeBash(`cat x.sh | bash -c ${JSON.stringify(body)}`, context), ['ask', 'コマンドの入れ子が深く、判定しきれない']);
  });
});
