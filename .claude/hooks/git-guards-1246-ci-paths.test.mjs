// #1246 / PR #1251: CI レビューで判明した標準入力の継承とパス表記ゆれ。
// 本文は judgeBash の字面判定にだけ渡し、危険なコマンドは実行しない。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1246-piped-script-guard' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

describe('#1246 CI: 標準入力のパスの表記ゆれ', () => {
  for (const command of [
    "echo 'wrangler deploy' | bash /dev//stdin",
    "echo 'wrangler deploy' | bash /dev/./stdin",
    "echo 'wrangler deploy' | bash /dev/../dev/stdin",
    "echo 'wrangler deploy' | source /proc/self/fd//0",
    "echo 'wrangler deploy' | . /proc/self/fd/./0",
    `echo '<?php file_get_contents(".env");' | php -f /dev//stdin`,
    `echo '<?php file_get_contents(".env");' | php --file=/dev/./stdin`,
  ]) {
    test(`[すり抜け・拒否] ${command}`, () => assert.equal(decision(command), 'deny', command));
  }
  for (const command of [
    'cat x.sh | bash /dev//stdin',
    'cat x.php | php --file=/proc/self/fd//0',
  ]) {
    test(`[すり抜け・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
  for (const command of [
    "echo 'wrangler deploy' | bash ./scripts/../x.sh",
    "echo 'wrangler deploy' | source ./x.sh",
    `echo '<?php file_get_contents(".env");' | php -f ./x.php`,
  ]) {
    test(`[完了条件・通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
});

// 正規化で './-' が '-' になっても、名前 '-' の実ファイルと標準入力の指定は別物。
describe('#1246 CI: 相対パスのダッシュと標準入力を区別する', () => {
  for (const command of [
    "echo 'wrangler deploy' | bash ./-",
    "echo 'wrangler deploy' | source ./-",
    `echo 'print(open(".env").read())' | python3 ./-`,
  ]) {
    test(`[完了条件・通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
  test('[すり抜け・拒否] シェルへ単独の - を渡す形は標準入力を読む', () =>
    assert.equal(decision("echo 'wrangler deploy' | bash -"), 'deny'));
});
// Linux の thread-self も、実行中のスレッドの標準入力を開く別名。
describe('#1246: thread-self の標準入力の別名', () => {
  for (const command of [
    "echo 'wrangler deploy' | bash /proc/thread-self/fd/0",
    "echo 'wrangler deploy' | bash /proc/thread-self//fd/./0",
    "echo 'wrangler deploy' | source /proc/thread-self/fd/0",
    `echo '<?php file_get_contents(".env");' | php -f /proc/thread-self/fd/0`,
    `echo '<?php file_get_contents(".env");' | php --file=/proc/thread-self//fd/./0`,
  ]) {
    test(`[すり抜け・拒否] ${command}`, () => assert.equal(decision(command), 'deny', command));
  }
  for (const command of [
    'cat script.sh | bash /proc/thread-self/fd/0',
    'cat script.php | php -f /proc/thread-self//fd/./0',
  ]) {
    test(`[すり抜け・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
});
