// #301: 独立した崩す担当の第2巡。危険なコマンドは判定に渡すだけで実行しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '301-shell-guards' })?.[0] ?? 'allow';

// 語の一部だけが展開しても、引用符内の記号は literal のまま。
// Bash/zsh とも末尾 * は literal-prefix の名前だけに当たり、保護対象名にはならない。
for (const command of ['echo x > ".dev.var?"*', 'echo x > ".en[v]"*', 'echo x > "wrangler.json?"*']) {
  test(`[引用した記号と未引用globの連結] ${command}`, () => {
    assert.equal(decision(command), 'allow');
  });
}

// ANSI-C delimiter は文字列のまま比較せず、デコードした終端名で読む。
test('[ANSI-C delimiterの文字コード] 後ろの本番操作を拒否する', () => {
  const command = String.raw`x="$(cat <<$'E\x4fF'` + '\nhi\nEOF\n)"; wrangler deploy';
  assert.equal(decision(command), 'deny');
});

// プロセス置換の中に quoted heredoc があっても、シェルへ渡すスクリプトは確認する。
test('[プロセス置換とヒアドキュメントの組合せ] 中身を安全と推測しない', () => {
  const command = "bash <(cat <<'END'\necho harmless\nEND\n)";
  assert.equal(decision(command), 'ask');
});
