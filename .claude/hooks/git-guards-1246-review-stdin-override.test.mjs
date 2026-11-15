// #1246 / PR #1254: 明示入力を引き継ぐ inline 本文と、保守的な確認の境界。
// 危険な本文は judgeBash の字面判定だけに渡し、実行しない。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1246-review-followup' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

describe('#1246: inline のインタープリタが継承する明示入力', () => {
  for (const command of [
    `echo x | bash -c 'node' <<< 'require("fs").readFileSync(".env")'`,
    `echo x | bash -c 'python3' <<< 'print(open(".env").read())'`,
    `echo x | bash -c 'node' <<'EOF'\nrequire("fs").readFileSync(".env")\nEOF`,
    `echo x | bash -c 'python3' <<'EOF'\nprint(open(".env").read())\nEOF`,
    `bash -c 'node' <<< 'require("fs").readFileSync(".env")'`,
    `bash -c 'python3' <<< 'print(open(".env").read())'`,
  ]) {
    // 上書きされた本文を正確に判定できない場合も、安全側で確認に返す。
    test(`[すり抜け・拒否か確認] ${command}`, () =>
      assert.ok(['ask', 'deny'].includes(decision(command)), command));
  }
  for (const command of [
    "echo x | bash -c 'node' < script.js",
    "echo x | bash -c 'python3' < script.py",
  ]) {
    test(`[断る場合・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
  for (const command of [
    "echo x | bash -c 'bash' <<< 'ls'",
    "echo x | bash -c 'bash' <<'EOF'\nls\nEOF",
    `echo x | bash -c 'node <<< "console.log(1)"'`,
    `echo x | bash -c 'python3 <<< "print(1)"'`,
  ]) {
    test(`[完了条件・通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
});

describe('#1246: 読めない継承入力と起動オプションの確認', () => {
  for (const command of [
    "echo x | bash -c 'node < /dev/null'",
    "echo x | bash -c 'bash 0<&-'",
    "echo x | bash -c 'node --env-file .settings ./script.js'",
  ]) {
    // ファイルの実体やfdの閉鎖は追わず、明示した通常ファイルのargvと区別する。
    test(`[断る場合・確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
  }
  test('[完了条件・通す] --import は既知の値取りオプションで、指定ファイルへのstdinはデータ', () =>
    assert.equal(decision("echo x | bash -c 'node --import ./setup.mjs ./script.js'"), 'allow'));
});
// 継承するパイプの stderr と、グループ境界でも実行本文を素通りさせない。
describe('#1246: パイプとグループ境界の標準入力の継承', () => {
  for (const command of [
    "echo 'wrangler deploy' |& bash -c 'bash'",
    "{ echo 'wrangler deploy'; } | bash -c 'bash'",
    "echo 'wrangler deploy' | { bash -c 'bash'; }",
  ]) {
    test(`[すり抜け・拒否か確認] ${command}`, () =>
      assert.ok(['ask', 'deny'].includes(decision(command)), command));
  }
});
