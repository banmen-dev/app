// #1246 / PR #1251: CI レビューで判明した標準入力の継承とパス表記ゆれ。
// 本文は judgeBash の字面判定にだけ渡し、危険なコマンドは実行しない。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1246-piped-script-guard' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

describe('#1246 CI: 未知の起動オプションはスクリプト名を確定しない', () => {
  for (const command of [
    'echo ls | node --no-warnings script.js',
    'cat data.txt | node --no-warnings script.js',
  ]) {
    test(`[断る場合・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
  for (const command of [
    'echo ls | node script.js',
    'cat data.txt | node script.js',
  ]) {
    test(`[完了条件・通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
});
