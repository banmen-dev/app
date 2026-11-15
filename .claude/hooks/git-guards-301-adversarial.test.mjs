// #301: 独立した崩す担当の第1巡。本文は判定に渡すだけで実行しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '301-shell-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

// コメント内の引用符、括弧、ヒアドキュメント風の文字は、置換の終端を変えない。
// bash の無害な wrangler 関数で、置換の後ろのコマンドが実行されることを確認した。
for (const marker of ['"', "'", '(', '<<EOF']) {
  const command = `x="$(echo ")" # ${marker}\n)"; wrangler deploy`;
  test(`[コメント内の構文] ${JSON.stringify(command)}`, () => {
    assert.equal(decision(command), 'deny', command);
  });
}

// ANSI-C 引用では \' は引用符を閉じない。その後ろの ) も引用の内容になる。
for (const [command, expected] of [
  [String.raw`x=$(echo $'\')'; wrangler deploy)`, 'deny'],
  [String.raw`x=$(echo $'\')'; cat .dev.vars)`, 'deny'],
  [String.raw`x=$(echo $'\')'; echo x > wrangler.jsonc)`, 'ask'],
]) {
  test(`[ANSI-C 引用の括弧] ${command}`, () => {
    assert.equal(decision(command), expected, command);
  });
}

// 既存のシークレット判定は .env.production や .dev.vars.local も保護する。
for (const command of ['echo x > .en[v].production', 'echo x > .dev.var[s].local']) {
  test(`[シークレットの接尾部] ${command}`, () => {
    assert.equal(decision(command), 'deny', command);
  });
}

// 作業場所を追った設定ファイルの保護は、相対的な glob/brace でも維持する。
for (const command of [
  'cd .wrangler/deploy && echo x > config.jso[n]',
  'cd .wrangler/deploy && echo x > config.json{,x}',
  'cd .wrangler && echo x > deploy/config.jso[n]',
]) {
  test(`[場所から解決する設定] ${command}`, () => {
    assert.equal(decision(command), 'ask', command);
  });
}

test('[複数の括弧 glob] すべて消えるとシェルが標準入力を実行する', () => {
  const command = 'bash no(N) no2(N) <<< "wrangler deploy"';
  assert.equal(decision(command), 'deny', command);
});

// 引用符かエスケープで展開を止めた glob 記号は、シェルがその文字どおりの名前に書く。
for (const command of [
  'echo x > ".dev.var?"',
  String.raw`echo x > .dev.var\?`,
  'echo x > ".en[v]"',
  'echo x > "wrangler.json?"',
  'echo x > "wrangler.json{c,}"',
]) {
  test(`[展開しない宛先] ${command}`, () => {
    assert.equal(decision(command), 'allow', command);
  });
}

// 同じ宣言行の複数のヒアドキュメントは順に読み、本文の引用符と括弧を無視する。
test('[複数の終わりの印] 引用符と括弧の本文を飛ばして後ろのコマンドを見る', () => {
  const command = 'x="$(cat <<EOF.x <<\\END\ntext\nEOF.x\n\' ) \"\nEND\n)"; wrangler deploy';
  assert.equal(decision(command), 'deny', command);
});

// オプション終端や前置きを経ても、シェルに渡すプロセス置換を確認する。
for (const command of ['bash -- <(printf harmless)', 'env bash <(printf harmless)', 'bash nope(N) < <(printf harmless)']) {
  test(`[経由したプロセス置換] ${command}`, () => {
    assert.equal(decision(command), 'ask', command);
  });
}

// 記述子の数値に引用した空文字が続けば、全体はパスの語として読む。
test('[記述子風パスの連結] 引用した空文字でもシークレットへの書き込みを止める', () => {
  assert.equal(decision('echo x >&1""/../.dev.vars'), 'deny');
});
