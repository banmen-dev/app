// #301: PR #1231 の AI レビュー指摘を独立に固定する回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '301-shell-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

// スクリプトの受け手はシェルだけでなく RUNNERS / INTERPRETERS も含む。
for (const command of [
  `node <(echo "require('child_process').execSync('wrangler deploy')")`,
  `python3 <(printf 'import os; os.system("wrangler deploy")')`,
  'ruby <(printf harmless)',
  'perl <(printf harmless)',
  'php <(printf harmless)',
  'node < <(printf harmless)',
  'bash < =(echo harmless)',
  'python3 < =(echo harmless)',
]) {
  test(`[実行する道具へ渡すプロセス置換] ${command}`, () => {
    assert.equal(decision(command), 'ask', command);
  });
}

for (const command of ['diff <(ls a) <(ls b)', "echo '<(printf harmless)'"]) {
  test(`[実行しないデータの対照] ${command}`, () => {
    assert.equal(decision(command), 'allow', command);
  });
}
