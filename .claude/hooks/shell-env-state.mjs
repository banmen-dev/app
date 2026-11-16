// Claude Code が各 Bash の前に読む環境のファイル（~/.claude/session-env/<session_id>/ と ~/.claude/shell-snapshots/）の状態の確かめ。
// 書き込みのコマンドの字面（bash-rules.mjs の shellEnvFileAt）は、変数、argv、2 手に分けたスクリプトで書く形を追いきれない。
// ここは書いた手段を問わず、次の Bash が読むファイルが許した形かを毎回確かめる。記録（ハッシュの台帳）は持たない。台帳は同じ権限で書き換えられるため。
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// session-env に書いてよい変数の名前。個人のプラグインが SessionStart で書く（codex プラグイン）。
// 増やすときは、値がシェルの解釈を受けない形（下の EXPORT_LINE）で書かれることを確かめてから足す
export const SESSION_ENV_ALLOWED_NAMES = ['CODEX_COMPANION_SESSION_ID', 'CODEX_COMPANION_TRANSCRIPT_PATH', 'CLAUDE_PLUGIN_DATA'];

// session-start.sh がクラウドで書く Node の PATH の行。$PATH はここでだけ許す
const NODE_PATH_LINE = /^export PATH="\/opt\/node[0-9]+\/bin:\$PATH"$/;
// 引用符、$、バッククォート、\ と制御文字の無い、単一引用符の値
const EXPORT_LINE = /^export ([A-Z_][A-Z0-9_]*)='[^'$`\\\x00-\x1f\x7f]*'$/;

// shell-snapshots のファイルの名前。時刻はエポックのミリ秒
const SNAPSHOT_NAME = /^snapshot-[a-z]+-([0-9]{10,})-[a-z0-9]+\.sh$/;
// 名前の時刻から ctime までの猶予。手元の macOS では 0.3〜1.1 秒だった。シェルの起動ファイルが重い環境を見込んで広く取る
export const SNAPSHOT_GRACE_MS = 30_000;
// 名前の時刻より前の ctime は、時計の粒度の分だけ許す
const SNAPSHOT_EARLY_MS = 1_000;

// session_id は場所を引くのに使うので、.. や / を含むものは引かない
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

// session-env の 1 行が許す形か。空行も許す
export function sessionEnvLineAllowed(line) {
  if (line === '' || NODE_PATH_LINE.test(line)) return true;
  const match = EXPORT_LINE.exec(line);
  return match !== null && SESSION_ENV_ALLOWED_NAMES.includes(match[1]);
}

// shell-snapshots のファイル 1 つの問題。無ければ null。stat は lstat の結果
// ctime は書き込み、置き換え（mv、ln）、touch、chmod のどれでも今になり、利用者の権限では戻せない
export function snapshotProblem(name, stat) {
  const match = SNAPSHOT_NAME.exec(name);
  if (!match) return '名前の形が snapshot-<シェル>-<エポックms>-<乱数>.sh でない';
  if (!stat.isFile()) return stat.isSymbolicLink() ? 'リンク' : '通常のファイルでない';
  const delta = stat.ctimeMs - Number(match[1]);
  if (delta < -SNAPSHOT_EARLY_MS || delta > SNAPSHOT_GRACE_MS) return '作られた後に書き換えられた（ctime が名前の時刻から離れている）';
  return null;
}

// 場所が無いのは正常（SessionStart のフックが何も書かない、snapshot をまだ作っていない）。それ以外の読めないは問題として返す
function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sessionEnvProblems(dir) {
  const stat = lstatOrNull(dir);
  if (stat === null) return [];
  if (!stat.isDirectory()) return [`${dir}: ディレクトリでない（リンクを含む）`];
  const problems = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const fileStat = lstatOrNull(file);
    if (fileStat === null) continue;
    if (!fileStat.isFile()) {
      problems.push(`${file}: 通常のファイルでない（リンクを含む）`);
      continue;
    }
    const lines = readFileSync(file, 'utf8').split('\n');
    const bad = lines.findIndex((line) => !sessionEnvLineAllowed(line));
    if (bad !== -1) problems.push(`${file}: ${bad + 1} 行目が許した形でない`);
  }
  return problems;
}

function snapshotsProblems(dir) {
  const stat = lstatOrNull(dir);
  if (stat === null) return [];
  if (!stat.isDirectory()) return [`${dir}: ディレクトリでない（リンクを含む）`];
  const problems = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    // 読み出しの間に Claude Code が古いものを消したなら、次の Bash は読まない
    const fileStat = lstatOrNull(file);
    if (fileStat === null) continue;
    const problem = snapshotProblem(name, fileStat);
    if (problem) problems.push(`${file}: ${problem}`);
  }
  return problems;
}

// configDir は Claude Code の設定の場所（CLAUDE_CONFIG_DIR か ~/.claude）。問題の一覧を返す（無ければ空）。
// 確かめられないとき（session_id が無い、読めない）も問題として返し、素通りにしない
export function shellEnvStateProblems({ configDir, sessionId }) {
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir)) return ['Claude Code の設定の場所を引けない'];
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return ['入力の session_id が無いか形が違う'];
  const problems = [];
  for (const [check, dir] of [
    [sessionEnvProblems, path.join(configDir, 'session-env', sessionId)],
    [snapshotsProblems, path.join(configDir, 'shell-snapshots')],
  ]) {
    try {
      problems.push(...check(dir));
    } catch (error) {
      problems.push(`${dir}: 読めない（${error.code ?? error.message}）`);
    }
  }
  return problems;
}

// 理由の文。外れたファイルの名前と直し方を入れる
export function shellEnvStateReason(problems) {
  const shown = problems.slice(0, 5).join('、');
  const more = problems.length > 5 ? ` ほか ${problems.length - 5} 件` : '';
  return (
    `Claude Code が各 Bash の前に読む環境のファイルが、許した形から外れている（${shown}${more}）。` +
    'フックから見えない GIT_CONFIG_*、GH_REPO、PATH、関数の定義が以後のコマンドに付き、push の先や守りを替えうる。' +
    '中身を確かめ、身に覚えの無い行は消す。shell-snapshots の外れたファイルは消し、今のセッションのものなら Claude Code を起動し直す（許す形は docs/development.md の「Claude の設定とフック」）'
  );
}
