// #301: 新たなリダイレクト照合が既存の判定予算を使い切らないための回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// 所要時間の閾値ではなく、長さ・展開総量が大きいと照合を打ち切って確認に回す契約を確かめる。
for (const [label, pattern] of [
  ['長い名前', 'x'.repeat(5000) + '?'],
  ['長いドット列', '.'.repeat(5000) + '?'],
  ['個々は短くても展開総量が大きい', 'x'.repeat(1000) + '{1..256}?'],
]) {
  test(`[照合予算の上限] ${label}`, () => {
    assert.equal(decision('echo x > ' + pattern), 'ask');
  });
}

for (const pattern of ['report-?.log', 'report-{1..3}.log']) {
  test(`[短い安全な glob] ${pattern}`, () => {
    assert.equal(decision('echo x > ' + pattern), 'allow');
  });
}

// 予算超過の確認よりも、名前として明示された既知のシークレットの拒否を優先する。
for (const [label, pattern] of [
  ['長い brace の一方が .env', '{.env,' + 'x'.repeat(5000) + '}'],
  ['展開総量が大きい brace の一方が .dev.vars', '{.dev.vars,' + 'x'.repeat(1000) + '{1..256}}'],
]) {
  test(`[既知のシークレットの拒否を優先] ${label}`, () => {
    assert.equal(decision('echo x > ' + pattern), 'deny');
  });
}
