// #1246 / PR #1251: HIGH 修正の第2反証。パッケージマネージャーの inline 本文も fd0 を継承する。
// 危険な本文は実行せず、judgeBash の字面判定だけを呼ぶ。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1246-piped-script-guard' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

describe('#1246 CI HIGH 反証2: manager の inline 本文への標準入力継承', () => {
  for (const command of [
    "echo 'wrangler deploy' | npx --call='bash'",
    "echo 'wrangler deploy' | npm exec -c bash",
  ]) {
    test(`[すり抜け・拒否か確認] ${command}`, () =>
      assert.ok(['ask', 'deny'].includes(decision(command)), command));
  }
  for (const command of [
    "cat x.sh | npx --call='bash'",
    'cat x.sh | npm exec -c bash',
  ]) {
    test(`[すり抜け・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
  for (const command of [
    "echo 'wrangler deploy' | npx --call='cat'",
    "echo 'wrangler deploy' | npm exec -c cat",
    "echo 'wrangler deploy' | npx --call='bash x.sh'",
    "echo 'wrangler deploy' | npm exec -c 'bash x.sh'",
    "echo 'wrangler deploy' | npx --call='bash' <<< 'ls'",
    "echo 'wrangler deploy' | npm exec -c bash <<< 'ls'",
  ]) {
    test(`[完了条件・通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
});
