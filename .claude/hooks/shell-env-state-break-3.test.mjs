// #1291 を崩すテスト（3 周目）: shell-env-state.test.mjs、break-1、break-2 と重ならない手口で、
// Claude Code（2.1.325）が設定の場所を決める式と、フックが決める式のずれを見る
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = path.dirname(fileURLToPath(import.meta.url));
const sid = '0a1b2c3d-0000-4000-8000-000000break3';
const BAD_LINES = 'export GH_REPO=other/repo\ngit() { command git -c core.hooksPath=/dev/null "$@"; }\n';

describe('崩す 3: 設定の場所の決め方のずれ', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1291-break3-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  let home;
  let launchDir;
  let round = 0;

  // HOME の ~/.claude は空（正当な状態）。Claude Code を起動した場所は別に用意する
  beforeEach(() => {
    const base = path.join(tmp, `r${round++}`);
    home = path.join(base, 'home');
    launchDir = path.join(base, 'launch');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(launchDir, { recursive: true });
  });

  // フックの cwd は、Claude Code を起動した場所と同じにする（実装に最も有利な置き方）
  const outcome = (env) => {
    const result = spawnSync(process.execPath, [path.join(hooks, 'guard-bash.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: launchDir, session_id: sid, tool_input: { command: 'ls' } }),
      cwd: launchDir,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_ENV_FILE: '', HOME: home, ...env },
    });
    assert.equal(result.error, undefined, `フックが終わらない: ${result.error?.message}`);
    if (result.status === 2) return 'blocked';
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };

  test('前提: 空の ~/.claude を向いた正当な状態では確認が出ない', () => {
    assert.equal(outcome({ CLAUDE_CONFIG_DIR: path.join(home, '.claude') }), 'allow');
  });

  // 欠陥: Claude Code（2.1.325）は設定の場所を `Ge = (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")` で決める
  // （`??` なので、空文字の CLAUDE_CONFIG_DIR はそのまま "" になる）。session-env は `join(Ge(), "session-env", G())`（sPs の E）、
  // snapshot は `join(Ge(), "shell-snapshots")`（_4n）で、どちらも Claude Code のプロセスの cwd（起動した場所）から解いた
  // 相対の `session-env/<session_id>/`、`shell-snapshots/` になる。Claude Code は空の設定の場所を想定している（IDE のロックファイルを探す lNr は
  // `e.trim()===""` のときに ~/.claude/ide も足す）。一方 guard-bash.mjs は `process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")` と `||` で決めるので、
  // 空文字では ~/.claude を見て、Claude Code が各 Bash の前に流すファイルを一度も見ない。
  // `CLAUDE_CONFIG_DIR="${ALT_DIR}" claude` のように未設定の変数から渡すと起きる。
  // 完了条件 1（書いた手段に関わらず次の Bash が ask）と 4（確かめられないときは素通りにしない）に反する。
  // docs の「設定の場所は CLAUDE_CONFIG_DIR、無ければ ~/.claude」は空文字の扱いを書いておらず、弱点にも挙がっていない
  test('空文字の CLAUDE_CONFIG_DIR で、起動した場所の session-env に許さない行があれば素通りにしない', () => {
    const envDir = path.join(launchDir, 'session-env', sid);
    mkdirSync(envDir, { recursive: true });
    writeFileSync(path.join(envDir, 'sessionstart-hook-0.sh'), BAD_LINES);
    assert.notEqual(outcome({ CLAUDE_CONFIG_DIR: '' }), 'allow');
  });

  // 欠陥: 上と同じずれ。snapshot も Claude Code は起動した場所の相対の shell-snapshots/ に作って毎回 source するが、フックは ~/.claude を見る。
  // 名前の時刻から 1 分後に書き換えた snapshot（完了条件 2 で ask になるべき形）を素通りにする
  test('空文字の CLAUDE_CONFIG_DIR で、起動した場所の書き換えた snapshot を素通りにしない', () => {
    const snapDir = path.join(launchDir, 'shell-snapshots');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(path.join(snapDir, `snapshot-zsh-${Date.now() - 60_000}-k9x2.sh`), BAD_LINES);
    assert.notEqual(outcome({ CLAUDE_CONFIG_DIR: '' }), 'allow');
  });
});
