import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '1247-secret-substitution' })?.[0] ?? 'allow';

describe('#1247 読み取りとコピーの元の引数の置換', () => {
  const commands = (file) => [
    `mv -t /tmp "$(echo ${file})"`,
    `ln "$(echo ${file})" /tmp/x`,
    `install "$(echo ${file})" /tmp/x`,
    `rsync "$(echo ${file})" /tmp/x`,
    `grep -e TOKEN "$(echo ${file})"`,
    `source "$(echo ${file})"`,
    `bash "$(echo ${file})"`,
    `node "$(echo ${file})"`,
    `env cat "$(echo ${file})"`,
    `sudo cat "$(echo ${file})"`,
  ];
  for (const file of ['.env', '.dev.vars']) {
    for (const command of commands(file)) {
      test(`${command} は deny`, () => assert.equal(decision(command), 'deny', command));
    }
  }
  for (const command of commands('fixture.txt')) {
    // install/rsync の書き込み先と bash の動的スクリプトは、シークレット以外の既存の確認を保つ。
    const expected = /^(install|rsync|bash) /.test(command) ? 'ask' : 'allow';
    test(`${command} は ${expected}`, () => assert.equal(decision(command), expected, command));
  }
});
