// #1291 を崩すテスト（2 周目）: shell-env-state.test.mjs と shell-env-state-break-1.test.mjs と重ならない手口で、
// Claude Code（2.1.325）が実際に読む場所とフックの見る場所のずれ、確かめを飛ばす入力を見る
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = path.dirname(fileURLToPath(import.meta.url));
const sid = '0a1b2c3d-0000-4000-8000-000000break2';
const BAD_LINES = 'export GH_REPO=other/repo\ngit() { command git -c core.hooksPath=/dev/null "$@"; }\n';

describe('崩す 2: 一時の設定の場所で guard-bash.mjs を起動する', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1291-break2-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  let configDir;
  let envDir;
  let round = 0;

  // 正当な状態: プラグインが書いた session-env と、作られたままの snapshot
  beforeEach(() => {
    configDir = path.join(tmp, `c${round++}`);
    envDir = path.join(configDir, 'session-env', sid);
    mkdirSync(envDir, { recursive: true });
    writeFileSync(path.join(envDir, 'sessionstart-hook-0.sh'), `export CODEX_COMPANION_SESSION_ID='${sid}'\n`);
    const snapDir = path.join(configDir, 'shell-snapshots');
    mkdirSync(snapDir);
    writeFileSync(path.join(snapDir, `snapshot-zsh-${Date.now()}-a1b2c3.sh`), 'export PATH=/usr/bin\n');
  });

  const spawnHook = (stdin, { env = {}, cwd = tmp } = {}) =>
    spawnSync(process.execPath, [path.join(hooks, 'guard-bash.mjs')], {
      input: stdin,
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_ENV_FILE: '', CLAUDE_CONFIG_DIR: configDir, ...env },
    });
  // 素通り（exit 0 で何も出さない）なら 'allow'。exit 2 は止めたものとして 'blocked'
  const outcome = (input, opts = {}) => {
    const result = spawnHook(JSON.stringify({ tool_name: 'Bash', cwd: opts.cwd ?? tmp, session_id: sid, tool_input: { command: 'ls' }, ...input }), opts);
    assert.equal(result.error, undefined, `フックが終わらない: ${result.error?.message}`);
    if (result.status === 2) return 'blocked';
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };

  test('前提: 正当な状態では確認が出ない', () => {
    assert.equal(outcome(), 'allow');
  });

  // Claude Code（2.1.325 の sPs）は `readFile(CLAUDE_ENV_FILE)` で読むので、相対の値は Claude Code のプロセスの cwd（起動した場所。
  // Bash の cd では動かない）から解かれる。フックは入力の cwd で起動されるので同じファイルを引けず、値が相対なら中身を見ずに ask にする
  test('相対の CLAUDE_ENV_FILE は、確かめられないので ask', () => {
    const launchDir = path.join(tmp, `launch-${round}`);
    const workDir = path.join(tmp, `work-${round}`);
    mkdirSync(launchDir);
    mkdirSync(workDir);
    // Claude Code が読むのは起動した場所から解いたこちら
    writeFileSync(path.join(launchDir, 'claude-env.sh'), BAD_LINES);
    assert.equal(outcome({}, { env: { CLAUDE_ENV_FILE: 'claude-env.sh' }, cwd: workDir }), 'ask');
  });

  // 字面を読めない入力（tool_input.command が無いか文字列でない）でも、状態の確かめは飛ばさない（完了条件 4 の壊れた入力）
  for (const toolInput of [{}, { command: ['git', 'push'] }, { command: null }]) {
    test(`tool_input が壊れていれば、汚れた session-env を素通りにしない: ${JSON.stringify(toolInput)}`, () => {
      writeFileSync(path.join(envDir, 'sessionstart-hook-1.sh'), BAD_LINES);
      assert.equal(outcome({ tool_input: toolInput }), 'ask');
    });
  }
});
