// PreToolUse（Bash、Monitor、PowerShell）の入口。判定は bash-rules.mjs。
// import されない前提で、起動されたら必ず判定する（シンボリックリンク経由で起動されても素通りしない）。
// 判定できないときは exit 2 で止める（onFailure を読まない古い Claude Code でも止まるように）。
// 判定のモジュールは try の中で読み込む。静的に import すると、読み込みの失敗が exit 1（素通り）になる。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// --abbrev-ref と symbolic-ref --short は、同名のタグがあると heads/main を返すので、完全な ref から名前を取る。
// detached HEAD とブランチを引けないときは undefined（push の先を判定できないものとして確認を挟む）
function branchOf(dir) {
  try {
    const ref = execFileSync('git', ['-C', dir, 'symbolic-ref', '--quiet', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref.replace(/^refs\/heads\//, '');
  } catch {
    return undefined;
  }
}

// dir から上へ探した最初の package.json のあるディレクトリ。無ければ undefined
function packageDirOf(dir) {
  if (!dir) return undefined;
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, 'package.json'))) return d;
    if (d === path.dirname(d)) return undefined;
  }
}

// 名前のスクリプトの中身。無ければ undefined。Object.prototype のキー（constructor、toString）をスクリプトとして返さない
function scriptOf(dir, name) {
  const d = packageDirOf(dir);
  const scripts = d && JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')).scripts;
  return scripts && Object.hasOwn(scripts, name) && typeof scripts[name] === 'string' ? scripts[name] : undefined;
}

// 次の Bash が読む環境のファイルの状態（shell-env-state.mjs）を、コマンドの字面と関係なく確かめて判定に重ねる。
// deny はそのまま。外れていれば ask にし、字面の判定の ask と重なれば理由を並べる
function withShellEnvState(verdict, sessionId, { shellEnvStateProblems, shellEnvStateReason, homeOrNull }) {
  if (verdict?.[0] === 'deny') return verdict;
  const home = homeOrNull();
  const configDir = process.env.CLAUDE_CONFIG_DIR || (home && path.join(home, '.claude'));
  const problems = shellEnvStateProblems({ configDir, sessionId, envFile: process.env.CLAUDE_ENV_FILE });
  if (problems.length === 0) return verdict;
  const reason = shellEnvStateReason(problems);
  return ['ask', verdict ? `${verdict[1]}。${reason}` : reason];
}

try {
  const { judgeBash } = await import('./bash-rules.mjs');
  const stateCheck = { ...(await import('./shell-env-state.mjs')), homeOrNull: (await import('./file-rules.mjs')).homeOrNull };
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input.tool_input?.command;
  let commandVerdict = null;
  if (typeof command === 'string') {
    // セッションの CDPATH は、相対の cd の行き先を cwd の外へ変える（judgeBash は空文字を無いものとする）。
    // GH_REPO、GH_HOST、GIT_DIR、GIT_WORK_TREE、GIT_CONFIG_* は、gh が宛先と現在のブランチを決める元になるので、起動元の環境にあっても見る。
    // CLAUDE_ENV_FILE は、Claude Code が各 Bash の前に読むファイルの場所。PreToolUse のフックの環境にはふつう無い（SessionStart のフックだけが持つ）ので、
    // 字面の判定の中心は名前（session-env、shell-snapshots）で、これは名前に当たらない場所に置かれていたときの補助
    const env = Object.fromEntries(
      ['CDPATH', 'GH_REPO', 'GH_HOST', 'GIT_DIR', 'GIT_WORK_TREE', 'CLAUDE_ENV_FILE', ...Object.keys(process.env).filter((name) => /^GIT_CONFIG_/.test(name))].map((name) => [name, process.env[name]]),
    );
    commandVerdict = judgeBash(command, { cwd: input.cwd ?? process.cwd(), branchOf, scriptOf, packageDirOf, env });
  }
  // 状態の確かめは、command が無いか文字列でない入力でも行う（字面を読めない入力を素通りにしない）
  const verdict = withShellEnvState(commandVerdict, input.session_id, stateCheck);
  if (verdict) {
    const [decision, reason] = verdict;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: `${reason}（.claude/hooks/bash-rules.mjs）`,
        },
      }),
    );
  }
} catch (error) {
  process.stderr.write(`guard-bash: 判定できなかったので止めました: ${error.message}\n`);
  process.exit(2);
}
