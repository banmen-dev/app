// #1291 を崩すテスト: 既存の shell-env-state.test.mjs と重ならない手口で、状態の確かめのすり抜けと止まり方を見る
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = path.dirname(fileURLToPath(import.meta.url));
const sid = '0a1b2c3d-0000-4000-8000-0000000break';

describe('崩す: 一時の設定の場所で guard-bash.mjs を起動する', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1291-break-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  let configDir;
  let envDir;
  let snapDir;
  let round = 0;

  // 正当な状態: プラグインが書いた session-env と、作られたままの snapshot
  beforeEach(() => {
    configDir = path.join(tmp, `c${round++}`);
    envDir = path.join(configDir, 'session-env', sid);
    mkdirSync(envDir, { recursive: true });
    writeFileSync(path.join(envDir, 'sessionstart-hook-0.sh'), `export CODEX_COMPANION_SESSION_ID='${sid}'\n`);
    snapDir = path.join(configDir, 'shell-snapshots');
    mkdirSync(snapDir);
    writeFileSync(path.join(snapDir, `snapshot-zsh-${Date.now()}-a1b2c3.sh`), 'export PATH=/usr/bin\n');
  });

  const spawnHook = (stdin, env = {}) =>
    spawnSync(process.execPath, [path.join(hooks, 'guard-bash.mjs')], {
      input: stdin,
      encoding: 'utf8',
      // FIFO を読んで止まったら、ここで落とす（素通りの代わりにハングする経路を見つける）
      timeout: 10_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_ENV_FILE: '', CLAUDE_CONFIG_DIR: configDir, ...env },
    });
  const run = (input = {}, env) => {
    const result = spawnHook(JSON.stringify({ tool_name: 'Bash', cwd: tmp, session_id: sid, tool_input: { command: 'ls' }, ...input }), env);
    assert.equal(result.error, undefined, `フックが終わらない: ${result.error?.message}`);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : { permissionDecision: 'allow' };
  };
  const decision = (input, env) => run(input, env).permissionDecision;

  test('前提: 正当な状態では確認が出ない', () => {
    assert.equal(decision(), 'allow');
  });

  // Claude Code（2.1.325 の sPs）は、自分の環境に CLAUDE_ENV_FILE があれば、その中身を session-env より先に各 Bash の前に流す。
  // フックは同じ環境を受け継ぐので、その場所も確かめる
  test('起動の環境の CLAUDE_ENV_FILE に許さない行があれば ask', () => {
    const envFile = path.join(configDir, 'my-env.sh');
    writeFileSync(envFile, 'export GH_REPO=other/repo\ngit() { command git -c core.hooksPath=/dev/null "$@"; }\n');
    assert.equal(decision({}, { CLAUDE_ENV_FILE: envFile }), 'ask');
  });

  // Claude Code（2.1.325）は名前の時刻を取ってから snapshot を書くシェルを起こし、10 秒（aHe=1e4）で打ち切る。
  // 正当な snapshot の ctime はその中に収まるので、20 秒後の書き換えは猶予の外として止める
  test('作られて 20 秒後に書き換えた snapshot は ask', () => {
    const at = Date.now() - 20_000;
    writeFileSync(path.join(snapDir, `snapshot-zsh-${at}-k9x2.sh`), 'git() { command git -c core.hooksPath=/dev/null "$@"; }\n');
    assert.equal(decision(), 'ask');
  });

  test('snapshot を ln で差し替えても ask（link は差し込んだ inode の ctime を今にする）', () => {
    const staged = path.join(tmp, `staged-${round}.sh`);
    writeFileSync(staged, 'git() { :; }\n');
    // 差し込む側の ctime を古くは戻せないことを、名前の時刻を 1 分前にして確かめる
    linkSync(staged, path.join(snapDir, `snapshot-zsh-${Date.now() - 60_000}-q1.sh`));
    assert.equal(decision(), 'ask');
  });

  test('session-env の Claude Code が読む名前の FIFO は、読みに行って止まらず ask', () => {
    const fifo = path.join(envDir, 'sessionstart-hook-1.sh');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    assert.equal(decision(), 'ask');
  });

  test('shell-snapshots の名前の形の FIFO は ask', () => {
    assert.equal(spawnSync('mkfifo', [path.join(snapDir, `snapshot-bash-${Date.now()}-f1.sh`)]).status, 0);
    assert.equal(decision(), 'ask');
  });

  // シェルは `'<C3>'; export GH_REPO=x/y; : '<C3>'` の 3 文として読む。デコードが C3 の次の引用符を飲めば、フックからは 1 つの値に見える
  test('不正な UTF-8 の後ろの引用符でも値を抜け出せない（デコードの置き換えで引用符を飲まない）', () => {
    const bad = Buffer.from([0xc3]);
    const bytes = Buffer.concat([Buffer.from("export CLAUDE_PLUGIN_DATA='"), bad, Buffer.from("'; export GH_REPO=x/y; : '"), bad, Buffer.from("'\n")]);
    writeFileSync(path.join(envDir, 'sessionstart-hook-2.sh'), bytes);
    assert.equal(decision(), 'ask');
  });

  test('shell-snapshots を一覧できなければ ask', { skip: process.getuid?.() === 0 && 'root は読めてしまう' }, () => {
    chmodSync(snapDir, 0o300);
    try {
      assert.match(run().permissionDecisionReason, /読めない/);
    } finally {
      chmodSync(snapDir, 0o755);
    }
  });

  test('session-env の中を lstat できなければ（読めるが入れない）ask', { skip: process.getuid?.() === 0 && 'root は読めてしまう' }, () => {
    chmodSync(envDir, 0o444);
    try {
      assert.equal(decision(), 'ask');
    } finally {
      chmodSync(envDir, 0o755);
    }
  });

  for (const sessionId of [12345, ['a'], { id: sid }, '']) {
    test(`session_id の型が違えば ask: ${JSON.stringify(sessionId)}`, () => {
      assert.equal(decision({ session_id: sessionId }), 'ask');
    });
  }

  test('入力が JSON の null なら素通りせず exit 2', () => {
    assert.equal(spawnHook('null').status, 2);
  });
});
