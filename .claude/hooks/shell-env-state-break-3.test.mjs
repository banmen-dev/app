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

  // Claude Code（2.1.325）は設定の場所を `(CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")` で決めるので、
  // 空文字はそのまま使われ、session-env と shell-snapshots は Claude Code を起動した場所からの相対になる（`CLAUDE_CONFIG_DIR="${ALT_DIR}" claude`
  // で ALT_DIR が未設定のとき）。フックからは同じ場所を引けないので、~/.claude に倒さず、中身を見ずに ask にする
  test('空文字の CLAUDE_CONFIG_DIR は、起動した場所の session-env を確かめられないので ask', () => {
    const envDir = path.join(launchDir, 'session-env', sid);
    mkdirSync(envDir, { recursive: true });
    writeFileSync(path.join(envDir, 'sessionstart-hook-0.sh'), BAD_LINES);
    assert.equal(outcome({ CLAUDE_CONFIG_DIR: '' }), 'ask');
  });

  // 上と同じく、snapshot も起動した場所の相対の shell-snapshots/ に作られるので、中身を見ずに ask にする
  test('空文字の CLAUDE_CONFIG_DIR は、起動した場所の snapshot を確かめられないので ask', () => {
    const snapDir = path.join(launchDir, 'shell-snapshots');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(path.join(snapDir, `snapshot-zsh-${Date.now() - 60_000}-k9x2.sh`), BAD_LINES);
    assert.equal(outcome({ CLAUDE_CONFIG_DIR: '' }), 'ask');
  });
});
