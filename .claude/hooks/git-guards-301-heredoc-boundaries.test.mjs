// node --test .claude/hooks/git-guards-301-heredoc-boundaries.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// bash で、<< は終端行を厳密に照合し、<<- は先頭のタブだけを取り除く。
// 偽終端に続く )" も本文の一部なので、その後の本当の終端まで括弧・引用符を数えない。
const falseTerminators = [
  ['<<', ' EOF.x', '先頭スペース'],
  ['<<', '\tEOF.x', '先頭タブ'],
  ['<<', 'EOF.x ', '末尾スペース'],
  ['<<', 'EOF.x\t', '末尾タブ'],
  ['<<-', ' EOF.x', '先頭スペース'],
  ['<<-', '\t EOF.x', '先頭タブの後のスペース'],
  ['<<-', 'EOF.x ', '末尾スペース'],
  ['<<-', 'EOF.x\t', '末尾タブ'],
];

describe('Issue #301: コマンド置換内のヒアドキュメントの終端行を厳密に読む', () => {
  for (const [op, falseEnd, label] of falseTerminators) {
    test(`${op} の${label}は終端にならず、実際の終端の後の本番操作を拒否する`, () => {
      const command = `x="$(cat ${op}EOF.x\n${falseEnd}\n)"\nEOF.x\n)"; wrangler deploy`;
      assert.equal(decision(command), 'deny');
    });
    test(`${op} の${label}は終端にならず、本番操作の文字列が本文なら通す`, () => {
      const command = `x="$(cat ${op}EOF.x\n${falseEnd}\n)"\nwrangler deploy\nEOF.x\n)"; echo harmless`;
      assert.equal(decision(command), 'allow');
    });
    test(`${op} の${label}しか無く、本当の終端行が無ければ確認する`, () => {
      const command = `x="$(cat ${op}EOF.x\n${falseEnd}\n)"`;
      assert.equal(decision(command), 'ask');
    });
  }

  for (const [op, end, label] of [
    ['<<', 'EOF.x', '厳密一致'],
    ['<<-', '\tEOF.x', '先頭タブ1つ'],
    ['<<-', '\t\tEOF.x', '先頭タブ2つ'],
  ]) {
    test(`${op} の有効な終端（${label}）の後の本番操作を拒否する`, () => {
      assert.equal(decision(`x="$(cat ${op}EOF.x\nhi\n${end}\n)"; wrangler deploy`), 'deny');
    });
    test(`${op} の有効な終端（${label}）の後の安全な操作を通す`, () => {
      assert.equal(decision(`x="$(cat ${op}EOF.x\nhi\n${end}\n)"; echo harmless`), 'allow');
    });
  }
});
