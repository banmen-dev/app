// #301: 最終レビューで見つかった引用コンマの固定回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// 引用したコンマは brace の区切りではなく、展開先の名前に残る。
for (const command of ['echo x > wrangler.jso{n","x,m}']) {
  test(`[引用コンマを名前に残す] ${command}`, () => {
    assert.equal(decision(command), 'allow', command);
  });
}

// 引用しないコンマは区切りなので、守る名前も展開先に含まれる。
for (const [command, expected] of [['echo x > wrangler.jso{n,x,m}', 'ask']]) {
  test(`[引用しないコンマで展開する] ${command}`, () => {
    assert.equal(decision(command), expected, command);
  });
}
