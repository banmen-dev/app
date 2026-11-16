// #1291: 次の Bash が読む環境のファイル（session-env、shell-snapshots）の状態を、書いた手段に関わらず毎回確かめる
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_GRACE_MS, sessionEnvLineAllowed, shellEnvStateProblems, shellEnvStateReason, snapshotProblem } from './shell-env-state.mjs';

const hooks = path.dirname(fileURLToPath(import.meta.url));

describe('session-env の行', () => {
  test('session-start.sh が書く Node の PATH の行を許す', () => {
    const script = readFileSync(path.join(hooks, 'session-start.sh'), 'utf8');
    const literal = /^\s*line="(.*)"$/m.exec(script)?.[1];
    assert.ok(literal, 'session-start.sh の line= を読めない');
    // シェルの二重引用符の中の \" と \$ を戻し、主版を入れる
    const line = literal.replace(/\\(["$])/g, '$1').replace('${node_major}', '26');
    assert.equal(line, 'export PATH="/opt/node26/bin:$PATH"');
    assert.equal(sessionEnvLineAllowed(line), true);
  });

  for (const line of [
    '',
    "export CODEX_COMPANION_SESSION_ID='0a1b2c3d-0000-4000-8000-000000000000'",
    "export CODEX_COMPANION_TRANSCRIPT_PATH='/home/u/.claude/projects/x/0a1b.jsonl'",
    "export CLAUDE_PLUGIN_DATA='/home/u/.claude/plugins/data/codex-openai-codex'",
    "export CLAUDE_PLUGIN_DATA=''",
  ]) {
    test(`[許す] ${JSON.stringify(line)}`, () => assert.equal(sessionEnvLineAllowed(line), true));
  }

  for (const line of [
    'export GH_REPO=other/repo',
    "export GH_REPO='other/repo'",
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:refs/heads/main',
    'git() { command git "$@"; }',
    'export PATH="/tmp/bin:$PATH"',
    'export PATH="/opt/node26/bin:$PATH"; export GH_REPO=x/y',
    "export CLAUDE_PLUGIN_DATA='$(id)'",
    "export CLAUDE_PLUGIN_DATA='a'\\''b'",
    "export CLAUDE_PLUGIN_DATA='`id`'",
    "export CLAUDE_PLUGIN_DATA='x'; git config core.hooksPath /tmp",
    "export CLAUDE_PLUGIN_DATA=\"x\"",
    "export CLAUDE_PLUGIN_DATA='x'\r",
    " export CLAUDE_PLUGIN_DATA='x'",
    "export claude_plugin_data='x'",
    "export CLAUDE_PLUGIN_DATA='a\\b'",
    "export CLAUDE_PLUGIN_DATA='a\x7fb'",
    'alias git=/tmp/git',
    '# コメント',
  ]) {
    test(`[外す] ${JSON.stringify(line)}`, () => assert.equal(sessionEnvLineAllowed(line), false));
  }
});

describe('shell-snapshots のファイル', () => {
  const at = 1794788963322;
  const stat = (ctimeMs, kind = 'file') => ({ ctimeMs, isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' });
  const name = `snapshot-zsh-${at}-mzfo83.sh`;

  test('作られたままなら問題なし', () => {
    assert.equal(snapshotProblem(name, stat(at + 333)), null);
    assert.equal(snapshotProblem(`snapshot-bash-${at}-a1.sh`, stat(at + SNAPSHOT_GRACE_MS)), null);
    // Claude Code が名前の後ろにセッションの識別を付ける形
    assert.equal(snapshotProblem(`snapshot-zsh-${at}-mzfo83-0a1b2c3d-0000-4000-8000-000000000000.sh`, stat(at + 333)), null);
  });
  test('猶予は snapshot を書くシェルの打ち切り（10 秒）に近く取る', () => {
    assert.ok(SNAPSHOT_GRACE_MS >= 10_000 && SNAPSHOT_GRACE_MS <= 15_000);
  });
  test('名前の時刻より前の ctime は 1 秒まで許す', () => {
    assert.equal(snapshotProblem(name, stat(at - 1_000)), null);
    assert.match(snapshotProblem(name, stat(at - 1_001)), /ctime/);
    assert.match(snapshotProblem(name, stat(at + SNAPSHOT_GRACE_MS + 1)), /ctime/);
  });
  test('猶予を超えて ctime が動いたら外す', () => {
    assert.match(snapshotProblem(name, stat(at + SNAPSHOT_GRACE_MS + 1)), /ctime/);
    assert.match(snapshotProblem(name, stat(at - 5_000)), /ctime/);
  });
  test('リンクと通常のファイルでないものは外す', () => {
    assert.match(snapshotProblem(name, stat(at, 'link')), /リンク/);
    assert.match(snapshotProblem(name, stat(at, 'dir')), /通常のファイルでない/);
  });
  for (const bad of ['x.sh', `snapshot-zsh-${at}-mzfo83.sh.bak`, `snapshot-zsh-${at}.sh`, `prefix-snapshot-zsh-${at}-a.sh`, `.DS_Store`, `snapshot-zsh-abc-x.sh`]) {
    test(`名前の形が違う: ${bad}`, () => assert.match(snapshotProblem(bad, stat(at)), /名前/));
  }
});

describe('一時の設定の場所で確かめる', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1291-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const sid = '0a1b2c3d-0000-4000-8000-000000000000';
  let configDir;
  let envFile;
  let snapshot;
  let round = 0;

  // 正当な状態: プラグインと session-start.sh が書いた session-env と、作られたままの snapshot
  beforeEach(() => {
    configDir = path.join(tmp, `c${round++}`);
    const envDir = path.join(configDir, 'session-env', sid);
    mkdirSync(envDir, { recursive: true });
    envFile = path.join(envDir, 'sessionstart-hook-0.sh');
    writeFileSync(envFile, `export CODEX_COMPANION_SESSION_ID='${sid}'\nexport CLAUDE_PLUGIN_DATA='/home/u/.claude/plugins/data/codex'\n\n`);
    writeFileSync(path.join(envDir, 'sessionstart-hook-1.sh'), 'export PATH="/opt/node26/bin:$PATH"\n');
    mkdirSync(path.join(configDir, 'shell-snapshots'));
    snapshot = path.join(configDir, 'shell-snapshots', `snapshot-zsh-${Date.now()}-a1b2c3.sh`);
    writeFileSync(snapshot, 'export PATH=/usr/bin\n');
  });

  const run = (command, input = {}) => {
    const result = spawnSync(process.execPath, [path.join(hooks, 'guard-bash.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: tmp, session_id: sid, tool_input: { command }, ...input }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_CONFIG_DIR: configDir },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : { permissionDecision: 'allow' };
  };
  const decision = (command = 'ls', input) => run(command, input).permissionDecision;

  test('正当な状態では確認が出ない', () => {
    assert.equal(decision(), 'allow');
  });
  test('場所が無ければ確認が出ない（SessionStart が何も書かず、snapshot もまだ無い）', () => {
    rmSync(configDir, { recursive: true });
    assert.equal(decision(), 'allow');
  });

  for (const line of ['export GH_REPO=other/repo', 'git() { command git "$@"; }', "export FOO_BAR='x'", "export CLAUDE_PLUGIN_DATA='$HOME'"]) {
    test(`session-env に書き足すと、次の Bash が ask: ${line}`, () => {
      appendFileSync(envFile, `${line}\n`);
      const out = run('ls');
      assert.equal(out.permissionDecision, 'ask');
      assert.match(out.permissionDecisionReason, /sessionstart-hook-0\.sh: 4 行目/);
    });
  }
  test('session-env に許さない形のファイルを足すと ask', () => {
    writeFileSync(path.join(path.dirname(envFile), 'extra.sh'), 'export GH_REPO=x/y\n');
    assert.equal(decision(), 'ask');
  });
  test('session-env のリンクとディレクトリは ask', () => {
    symlinkSync(path.join(tmp, 'elsewhere.sh'), path.join(path.dirname(envFile), 'link.sh'));
    assert.match(run('ls').permissionDecisionReason, /link\.sh: 通常のファイルでない/);
  });
  test('session-env の場所そのものがリンクなら ask', () => {
    const real = path.join(configDir, 'real');
    renameSync(path.dirname(envFile), real);
    symlinkSync(real, path.dirname(envFile));
    assert.equal(decision(), 'ask');
  });

  test('snapshot を書き換えると ask', () => {
    // 名前の時刻を猶予より前にずらし、作った後に書き換えたのと同じ ctime と名前の開きを作る
    const old = path.join(path.dirname(snapshot), `snapshot-zsh-${Date.now() - SNAPSHOT_GRACE_MS - 5_000}-a1b2c3.sh`);
    writeFileSync(old, 'export GH_REPO=x/y\n');
    const out = run('ls');
    assert.equal(out.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, new RegExp(path.basename(old).replace(/\./g, '\\.')));
  });
  test('snapshot をほかのファイルで置き換えると ask（mv は ctime を今にする）', () => {
    const old = path.join(path.dirname(snapshot), `snapshot-zsh-${Date.now() - 60_000}-a1b2c3.sh`);
    const staged = path.join(tmp, `staged-${round}.sh`);
    writeFileSync(staged, 'export GH_REPO=x/y\n');
    renameSync(staged, old);
    assert.equal(decision(), 'ask');
  });
  test('名前の形が違うファイルとリンクは ask', () => {
    writeFileSync(path.join(path.dirname(snapshot), 'snapshot-zsh-evil.sh'), '');
    assert.equal(decision(), 'ask');
  });
  test('snapshot のリンクは ask', () => {
    symlinkSync(snapshot, path.join(path.dirname(snapshot), `snapshot-zsh-${Date.now()}-b2.sh`));
    assert.equal(decision(), 'ask');
  });
  test('shell-snapshots の場所がリンクなら ask', () => {
    const dir = path.join(configDir, 'shell-snapshots');
    renameSync(dir, path.join(configDir, 'snaps'));
    symlinkSync(path.join(configDir, 'snaps'), dir);
    assert.equal(decision(), 'ask');
  });

  test('Finder の .DS_Store は見ない', () => {
    writeFileSync(path.join(configDir, 'shell-snapshots', '.DS_Store'), '\0\0\0\x01Bud1');
    writeFileSync(path.join(path.dirname(envFile), '.DS_Store'), '\0\0\0\x01Bud1');
    assert.equal(decision(), 'allow');
  });
  test('大きすぎる session-env のファイルは読まずに ask', () => {
    writeFileSync(path.join(path.dirname(envFile), 'sessionstart-hook-2.sh'), '\n'.repeat(64 * 1024 + 1));
    assert.match(run('ls').permissionDecisionReason, /大きすぎる/);
  });
  test('理由の文は制御文字を替え、6 件目からは数だけ出す', () => {
    const problems = ['a\nfake: ok', 'b', 'c', 'd', 'e', 'f', 'g'];
    const reason = shellEnvStateReason(problems);
    assert.ok(!reason.includes('\n'));
    assert.match(reason, /a\?fake: ok/);
    assert.match(reason, /ほか 2 件/);
    assert.ok(!reason.includes('、f'));
    assert.ok(shellEnvStateReason(['x'.repeat(1000)]).length < 1000);
  });

  test('session_id が無いか形が違えば ask', () => {
    assert.equal(decision('ls', { session_id: undefined }), 'ask');
    assert.equal(decision('ls', { session_id: '../x' }), 'ask');
  });
  test('読めないファイルは ask', { skip: process.getuid?.() === 0 && 'root は読めてしまう' }, () => {
    chmodSync(envFile, 0o000);
    try {
      assert.match(run('ls').permissionDecisionReason, /読めない/);
    } finally {
      chmodSync(envFile, 0o644);
    }
  });
  test('字面の判定の deny はそのまま、ask は理由を並べる', () => {
    appendFileSync(envFile, 'export GH_REPO=x/y\n');
    assert.equal(decision('npx wrangler deploy'), 'deny');
    const out = run(`echo x >> ~/.claude/session-env/${sid}/x.sh`);
    assert.equal(out.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, /書き込みは人が確かめる。.*許した形から外れている/);
  });

  test('判定の関数は、設定の場所を引けなければ問題として返す', () => {
    assert.notDeepEqual(shellEnvStateProblems({ configDir: undefined, sessionId: sid }), []);
    assert.notDeepEqual(shellEnvStateProblems({ configDir: 'relative', sessionId: sid }), []);
  });
});
