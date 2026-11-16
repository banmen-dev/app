// #301: 最終レビューで見つかった指摘の独立した固定回帰テスト。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// 引用しない heredoc では本文の \<改行> を除いた後で終端を照合する。
// 最初の EOF.x は helloEOF.x の一部であり、直後の )" も本文になる。
for (const op of ['<<', '<<-']) {
  for (const [tail, expected] of [
    ['wrangler deploy', 'deny'],
    ['cat .dev.vars', 'deny'],
    ['echo x > wrangler.jsonc', 'ask'],
  ]) {
    const command = `x="$(cat ${op}EOF.x\nhello\\\nEOF.x\n)"\nEOF.x\n)"; ${tail}`;
    test(`[継続後の終端 ${op}] ${tail}`, () => {
      assert.equal(decision(command), expected, command);
    });
  }
}

// 引用された終端なら本文の \<改行> は残り、次の EOF.x が有効な終端になる。
for (const delimiter of ["'EOF.x'", '"EOF.x"', String.raw`\EOF.x`, "$'EOF.x'"]) {
  for (const [tail, expected] of [['wrangler deploy', 'deny'], ['echo harmless', 'allow']]) {
    const command = `x="$(cat <<${delimiter}\nhello\\\nEOF.x\n)"; ${tail}`;
    test(`[引用した終端 ${delimiter}] ${tail}`, () => {
      assert.equal(decision(command), expected, command);
    });
  }
}

test('[引用しない終端が継続で消える] ほかに終端がなければ確認する', () => {
  assert.equal(decision('x="$(cat <<EOF.x\nhello\\\nEOF.x\n)"'), 'ask');
});

// # が既に始まった語に続けばコメントではない。引用・置換・代入・行継続も語を維持する。
for (const command of [
  'x="$(echo $(echo a)#)"; wrangler deploy',
  'x="$(echo $(echo a)#foo)"\nwrangler deploy',
  'x="$(echo "a"#foo)"; wrangler deploy',
  "x=\"$(echo 'a'#foo)\"; wrangler deploy",
  'x="$(echo ""#foo)"; wrangler deploy',
  String.raw`x="$(echo \)#foo)"; wrangler deploy`,
  String.raw`x="$(echo \ #)"; wrangler deploy`,
  'x="$(echo word\\\n#)"; wrangler deploy',
  'x="$(value=$(echo a)#foo; echo harmless)"; wrangler deploy',
  'x="$(value="a"#foo; echo harmless)"; wrangler deploy',
]) {
  test(`[語の途中の #] ${JSON.stringify(command)}`, () => {
    assert.equal(decision(command), 'deny', command);
  });
}

// 語を空白で終えた後の # は本当のコメントで、行内の ) や引用符は効かない。
for (const command of [
  'x="$(echo $(echo a) # )"; wrangler deploy\n)"; echo harmless',
  'x="$(echo "a" # )"; wrangler deploy\n)"; echo harmless',
  'x="$(echo a\t# )"; wrangler deploy\n)"; echo harmless',
]) {
  test(`[本当のコメント境界] ${JSON.stringify(command)}`, () => {
    assert.equal(decision(command), 'allow', command);
  });
}

// bracket expression 内で引用・エスケープされた ^ は否定演算子ではなく候補の1文字。
// .env-* は既存のシークレットの名前から除外され、引用した - もその意味を変えない。
for (const command of [
  'echo x > .en["^"x]',
  "echo x > .en['^'x]",
  String.raw`echo x > .en[\^x]`,
  'echo x > wrangler.jso["^"x]',
  "echo x > wrangler.jso['^'x]",
  String.raw`echo x > wrangler.jso[\^x]`,
  'echo x > .env"-"*',
]) {
  test(`[引用が演算子を無効にする] ${command}`, () => {
    assert.equal(decision(command), 'allow', command);
  });
}

for (const [command, expected] of [['echo x > .en[^x]', 'deny'], ['echo x > wrangler.jso[^x]', 'ask']]) {
  test(`[引用しない ^ は否定] ${command}`, () => {
    assert.equal(decision(command), expected, command);
  });
}

// 引用した ^ 自体が候補になっても、同じ集合の v/n が守る名前に一致すれば拒否・確認する。
for (const [command, expected] of [
  ['echo x > .en["^"v]', 'deny'],
  [String.raw`echo x > .en[\^v]`, 'deny'],
  ['echo x > wrangler.jso["^"n]', 'ask'],
]) {
  test(`[引用した ^ の文字クラスが守る名前に一致] ${command}`, () => {
    assert.equal(decision(command), expected, command);
  });
}
