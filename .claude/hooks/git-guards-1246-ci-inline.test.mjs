// #1246 / PR #1251: CI レビューで判明した標準入力の継承とパス表記ゆれ。
// 本文は judgeBash の字面判定にだけ渡し、危険なコマンドは実行しない。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1246-piped-script-guard' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

describe('#1246 CI: inline 本文から起動する道具へのパイプ入力', () => {
  for (const command of [
    "echo 'wrangler deploy' | bash -c 'bash'",
    "echo 'wrangler deploy' | sh -c 'exec sh'",
    "echo 'wrangler deploy' | bash -c 'source /dev/stdin'",
    "echo 'git push origin main' | bash -c 'bash'",
    "echo 'cat .env' | bash -c 'bash'",
    `echo 'print(open(".env").read())' | bash -c 'python3'`,
  ]) {
    // inline の起動先まで厳密に判定できない場合も、最低限 ask で人に返す。
    test(`[すり抜け・拒否か確認] ${command}`, () =>
      assert.ok(['ask', 'deny'].includes(decision(command)), command));
  }
  for (const command of [
    "cat x.sh | bash -c 'bash'",
    "cat x.sh | sh -c 'exec sh'",
    "cat x.sh | bash -c 'source /dev/stdin'",
    "cat x.py | bash -c 'python3'",
  ]) {
    test(`[すり抜け・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
  for (const command of [
    "echo 'wrangler deploy' | bash -c 'cat'",
    "cat data.txt | bash -c 'cat'",
    "echo 'wrangler deploy' | bash -c 'printf safe'",
    "echo 'wrangler deploy' | bash -c 'bash x.sh'",
    `echo 'print(open(".env").read())' | bash -c 'python3 x.py'`,
  ]) {
    test(`[完了条件・通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
});

