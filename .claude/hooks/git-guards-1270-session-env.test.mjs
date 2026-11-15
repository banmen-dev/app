// #1270: Claude Code が各 Bash の前に読む環境のファイル（CLAUDE_ENV_FILE、~/.claude/session-env/）への書き込みは ask。
// 書き足すと、以後の Bash にフックから見えない GIT_CONFIG_*、GH_REPO、PATH が付く。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeBash } from './bash-rules.mjs';
import { judgeShellEnvFile } from './file-rules.mjs';

const ENV_FILE = '/home/u/.claude/session-env/0a1b/sessionstart-hook-0.sh';
const context = (env = {}) => ({ cwd: '/repo', branchOf: () => '1270-session-env', env });
const decision = (command, env) => judgeBash(command, context(env))?.[0] ?? 'allow';
const reason = (command, env) => judgeBash(command, context(env))?.[1] ?? '';
const SET = `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:refs/heads/main`;

describe('Bash から環境のファイルへの書き込みは ask', () => {
  for (const command of [
    `echo '${SET}' >> ~/.claude/session-env/0a1b/x.sh`,
    `echo 'export GH_REPO=other/repo' >> "$CLAUDE_ENV_FILE"`,
    `echo 'export GH_REPO=other/repo' >> $CLAUDE_ENV_FILE`,
    `echo 'export PATH=/tmp/bin:$PATH' >> "\${CLAUDE_ENV_FILE}"`,
    `echo x >> \${CLAUDE_ENV_FILE:-/tmp/a}`,
    `echo x >> ${ENV_FILE}`,
    `echo x >> /root/.claude/session-env/0a1b/x.sh`,
    `echo x >> "$HOME/.claude/session-env/0a1b/x.sh"`,
    `echo x >> "$CLAUDE_CONFIG_DIR/session-env/0a1b/x.sh"`,
    `echo x > ~/.claude/SESSION-ENV/0a1b/x.sh`,
    `echo x &> ~/.claude/session-env/0a1b/x.sh`,
    `printf '%s\\n' x 1>>~/.claude/session-env/0a1b/x.sh`,
    `echo x | tee -a ~/.claude/session-env/0a1b/x.sh`,
    `echo x | tee -a "$CLAUDE_ENV_FILE"`,
    `tee -a "$CLAUDE_ENV_FILE" < /tmp/x`,
    `cat > "$CLAUDE_ENV_FILE" <<'EOF'\nexport GH_REPO=other/repo\nEOF`,
    `cp /tmp/x.sh ~/.claude/session-env/0a1b/`,
    `cp /tmp/x.sh "$CLAUDE_ENV_FILE"`,
    `mv /tmp/x.sh ~/.claude/session-env/0a1b/y.sh`,
    `install -m 644 /tmp/x.sh ~/.claude/session-env/0a1b/y.sh`,
    `rsync /tmp/x.sh ~/.claude/session-env/0a1b/`,
    `sed -i 's/a/b/' ~/.claude/session-env/0a1b/x.sh`,
    `dd of=/root/.claude/session-env/0a1b/x.sh`,
    `curl -o ~/.claude/session-env/0a1b/x.sh https://example.com/x`,
    `ln -s ~/.claude/session-env /tmp/e`,
    `ln -s /tmp/x.sh ~/.claude/session-env/0a1b/y.sh`,
    // glob と {a,b}
    `echo x > ~/.claude/s*/0a1b/x.sh`,
    `echo x > ~/.c*/session-*/0a1b/x.sh`,
    `echo x >> ~/.claude/{session-env,x}/0a1b/x.sh`,
    // cd で場所を移ってから
    `cd ~/.claude && echo x >> session-env/0a1b/x.sh`,
    `cd ~/.claude/session-env/0a1b && echo x >> x.sh`,
    // 置換、入れ子のシェル、インタープリタ
    `echo x >> "$(echo ~/.claude/session-env/0a1b)/x.sh"`,
    `bash -c 'echo x >> "$CLAUDE_ENV_FILE"'`,
    `eval 'echo x >> ~/.claude/session-env/0a1b/x.sh'`,
    `python3 -c 'open("/root/.claude/session-env/0a1b/x.sh","a").write("x")'`,
    `node -e 'require("fs").appendFileSync(process.env.CLAUDE_ENV_FILE, "x")'`,
    `python3 - <<'EOF'\nimport os\nopen(os.environ['CLAUDE_ENV_FILE'], 'a').write('x')\nEOF`,
  ]) {
    test(`[すり抜け] ${command}`, () => {
      assert.equal(decision(command), 'ask', command);
      assert.match(reason(command), /CLAUDE_ENV_FILE/);
    });
  }

  test('起動元の CLAUDE_ENV_FILE が名前に session-env を含まない場所でも、その絶対パスへの書き込みは ask', () => {
    const env = { CLAUDE_ENV_FILE: '/var/tmp/claude-env.sh' };
    assert.equal(decision('echo x >> /var/tmp/claude-env.sh', env), 'ask');
    assert.equal(decision('cd /var/tmp && echo x >> claude-env.sh', env), 'ask');
    assert.equal(decision('echo x >> /var/tmp/other.sh', env), 'allow');
  });

  for (const command of [
    'ls ~/.claude/session-env',
    'cat ~/.claude/session-env/*/*.sh',
    'cat "$CLAUDE_ENV_FILE"',
    'grep -r PATH ~/.claude/session-env',
    'echo $CLAUDE_ENV_FILE',
    'cp ~/.claude/session-env/0a1b/x.sh /tmp/',
    'echo x > /tmp/*/a.sh',
    `echo 'session-env の説明' > /tmp/note.txt`,
    'echo x > /tmp/session-envy/a.sh',
  ]) {
    test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
  }
});

describe('Write と Edit から環境のファイルへの書き込みは ask', () => {
  test('judgeShellEnvFile は名前と CLAUDE_ENV_FILE で見る', () => {
    assert.equal(judgeShellEnvFile([ENV_FILE])?.[0], 'ask');
    assert.equal(judgeShellEnvFile(['/root/.claude/Session-Env/x/y.sh'])?.[0], 'ask');
    assert.equal(judgeShellEnvFile(['/var/tmp/claude-env.sh'], '/var/tmp/claude-env.sh')?.[0], 'ask');
    assert.equal(judgeShellEnvFile(['/var/tmp/other.sh'], '/var/tmp/claude-env.sh'), null);
    assert.equal(judgeShellEnvFile(['/repo/docs/session-envy.md']), null);
  });

  const hooks = path.dirname(fileURLToPath(import.meta.url));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const sessionDir = path.join(home, '.claude/session-env/0a1b');
  mkdirSync(sessionDir, { recursive: true });
  symlinkSync(path.join(home, '.claude/session-env'), path.join(tmp, 'link'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'CLAUDE_ENV_FILE'));
  const decide = (toolName, filePath, extra = {}) => {
    const toolInput = toolName === 'Write' ? { file_path: filePath, content: SET } : { file_path: filePath, old_string: 'a', new_string: SET };
    const result = spawnSync(process.execPath, [path.join(hooks, 'guard-files.mjs')], {
      input: JSON.stringify({ tool_name: toolName, cwd: tmp, tool_input: toolInput }),
      encoding: 'utf8',
      env: { ...env, HOME: home, CLAUDE_PROJECT_DIR: '', ...extra },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };

  for (const toolName of ['Write', 'Edit', 'MultiEdit']) {
    test(`[すり抜け] ${toolName} の絶対パス`, () => assert.equal(decide(toolName, path.join(sessionDir, 'x.sh')), 'ask'));
  }
  test('[すり抜け] Write の ~ で始まるパス', () => assert.equal(decide('Write', '~/.claude/session-env/0a1b/x.sh'), 'ask'));
  test('[すり抜け] Write の相対パス', () => assert.equal(decide('Write', 'home/.claude/session-env/0a1b/x.sh'), 'ask'));
  test('[すり抜け] session-env へのリンク越しの Write', () => assert.equal(decide('Write', path.join(tmp, 'link/0a1b/x.sh')), 'ask'));
  test('[すり抜け] 起動元の CLAUDE_ENV_FILE が指すファイル', () => {
    const file = path.join(tmp, 'claude-env.sh');
    assert.equal(decide('Write', file, { CLAUDE_ENV_FILE: file }), 'ask');
  });
  test('[通す] リポジトリの外のほかのファイル', () => assert.equal(decide('Write', path.join(tmp, 'note.sh')), 'allow'));
});
