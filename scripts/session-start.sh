#!/usr/bin/env bash
# クラウドのセッションの Bash で、PATH の先頭に /opt/node<主版>/bin を足す（SessionStart のフックから呼ぶ。docs/development.md の「クラウド環境」）。
# Claude の Bash は初期化ファイルを読まないので、セットアップスクリプト（scripts/cloud-setup.sh）が入れた Node 26 は、ここで CLAUDE_ENV_FILE に書かないと選ばれない。
# 主版は .node-version から取る。CLAUDE_ENV_FILE が無い、/opt/node<主版>/bin/node が動かない、のときは何も書かずに終了コード 0 で終える
# （手元とワークツリーの対話のセッションを変えない。終了コードが 0 以外だとフックが失敗として出る）。
# テスト用に、CLAUDE_PROJECT_DIR（.node-version の置き場所）と BANMEN_NODE_ROOT（/opt の置き換え）を読む。

root="${BANMEN_NODE_ROOT:-/opt}"
project="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)}"

[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
[ -r "${project}/.node-version" ] || exit 0

version=$(head -n 1 "${project}/.node-version" 2>/dev/null | tr -d '[:space:]')
version="${version#v}"
major="${version%%.*}"
[[ "$major" =~ ^[0-9]+$ ]] || exit 0

bin="${root}/node${major}/bin"
got=$("${bin}/node" --version 2>/dev/null) || exit 0
[[ "$got" == "v${major}."* ]] || exit 0

# 同じ行を二重に書かない（再開や clear でもう一度走る）
line="export PATH=\"${bin}:\$PATH\""
grep -qxF -- "$line" "$CLAUDE_ENV_FILE" 2>/dev/null || printf '%s\n' "$line" >> "$CLAUDE_ENV_FILE" 2>/dev/null
exit 0
