// #1270: Claude Code が各 Bash の前に読む環境のファイル（CLAUDE_ENV_FILE、~/.claude/session-env/、~/.claude/shell-snapshots/）への書き込みは ask。
// done-check の指摘のすり抜け（別名、リンク、glob、awk、書庫、cd の戻り、env -C、パイプのインタープリタ、表に無い道具）と、止めすぎを直した通す形。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_DIR, SHELL_ENV_DIR_NAMES, SHELL_ENV_REASON, judgeShellEnvFile } from './file-rules.mjs';

const context = (env = {}) => ({ cwd: '/repo', branchOf: () => '1270-session-env', env });
const verdict = (command, env) => judgeBash(command, context(env));
const decision = (command, env) => verdict(command, env)?.[0] ?? 'allow';
const reason = (command, env) => verdict(command, env)?.[1] ?? '';
const SET = `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:refs/heads/main`;

const expectAsk = (command, env) => {
  assert.equal(decision(command, env), 'ask', command);
  assert.equal(reason(command, env), SHELL_ENV_REASON, command);
};
const expectAllow = (command, env) => assert.equal(decision(command, env), 'allow', command);

const hooks = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-shell-env-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// GIT_* と CLAUDE_ENV_FILE、クラウドの印を引き継がない
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !['CLAUDE_ENV_FILE', 'CLAUDE_CODE_REMOTE'].includes(key)),
);
const runGuardFiles = (toolName, filePath, { cwd = tmp, env = {} } = {}) => {
  const toolInput =
    toolName === 'Write'
      ? { file_path: filePath, content: SET }
      : toolName === 'MultiEdit'
        ? { file_path: filePath, edits: [{ old_string: 'a', new_string: SET }] }
        : { file_path: filePath, old_string: 'a', new_string: SET };
  const result = spawnSync(process.execPath, [path.join(hooks, 'guard-files.mjs')], {
    input: JSON.stringify({ tool_name: toolName, cwd, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...cleanEnv, CLAUDE_PROJECT_DIR: '', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  if (!result.stdout) return ['allow', ''];
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  return [output.permissionDecision, output.permissionDecisionReason];
};

describe('名前と理由の置き場（file-rules.mjs）', () => {
  test('[入れ物] 名前の一覧、名前の正規表現、理由の文', () => {
    assert.deepEqual(SHELL_ENV_DIR_NAMES, ['session-env', 'shell-snapshots']);
    assert.match('/root/.claude/session-env/x/a.sh', SHELL_ENV_DIR);
    assert.match('/root/.claude/Shell-Snapshots/a.sh', SHELL_ENV_DIR);
    assert.doesNotMatch('/repo/docs/session-envy.md', SHELL_ENV_DIR);
    assert.doesNotMatch('/repo/shell-snapshotsx/a.sh', SHELL_ENV_DIR);
    for (const word of ['CLAUDE_ENV_FILE', 'session-env', 'shell-snapshots']) assert.ok(SHELL_ENV_REASON.includes(word), word);
  });

  test('[入れ物] judgeShellEnvFile は shell-snapshots も見る', () => {
    assert.deepEqual(judgeShellEnvFile(['/home/u/.claude/shell-snapshots/snapshot-zsh-1.sh']), ['ask', SHELL_ENV_REASON]);
    assert.deepEqual(judgeShellEnvFile(['/home/u/.claude/SHELL-SNAPSHOTS/a.sh']), ['ask', SHELL_ENV_REASON]);
    assert.deepEqual(judgeShellEnvFile(['/home/u/.claude/session-env/0a1b/a.sh']), ['ask', SHELL_ENV_REASON]);
    assert.equal(judgeShellEnvFile(['/tmp/a.sh', '/tmp/b.sh']), null);
    assert.equal(judgeShellEnvFile(['/repo/shell-snapshotsx/a.sh']), null);
  });
});

describe('shell-snapshots への書き込みは session-env と同じく ask', () => {
  const SNAP = '~/.claude/shell-snapshots/snapshot-zsh-1.sh';
  for (const command of [
    `echo '${SET}' >> ${SNAP}`,
    `echo x > ${SNAP}`,
    `echo x &> ${SNAP}`,
    `echo x | tee -a ${SNAP}`,
    `cp /tmp/x.sh ~/.claude/shell-snapshots/`,
    `cp /tmp/x.sh ${SNAP}`,
    `mv /tmp/x.sh ${SNAP}`,
    `install -m 644 /tmp/x.sh ${SNAP}`,
    `sed -i 's/a/b/' ${SNAP}`,
    `dd of=/root/.claude/shell-snapshots/snapshot-zsh-1.sh`,
    `curl -o ${SNAP} https://example.com/x`,
    `ln -s ~/.claude/shell-snapshots /tmp/s`,
    `ln -s /tmp/x.sh ${SNAP}`,
    `python3 -c 'open("/root/.claude/shell-snapshots/snapshot-zsh-1.sh","a").write("x")'`,
    `node -e 'require("fs").appendFileSync("/root/.claude/shell-snapshots/a.sh", "x")'`,
    `cd ~/.claude && echo x >> shell-snapshots/snapshot-zsh-1.sh`,
    `cd ~/.claude/shell-snapshots && echo x >> snapshot-zsh-1.sh`,
    `echo x > ~/.claude/shell-*/snapshot-zsh-1.sh`,
    `echo x >> ~/.claude/{shell-snapshots,x}/snapshot-zsh-1.sh`,
    `echo x >> "$HOME/.claude/shell-snapshots/snapshot-zsh-1.sh"`,
    `echo x >> "$CLAUDE_CONFIG_DIR/shell-snapshots/snapshot-zsh-1.sh"`,
    `echo x >> /root/.claude/shell-snapshots/snapshot-zsh-1.sh`,
    `echo x >> ~/.claude/Shell-Snapshots/snapshot-zsh-1.sh`,
    `bash -c 'echo x >> ~/.claude/shell-snapshots/snapshot-zsh-1.sh'`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }

  for (const toolName of ['Write', 'Edit', 'MultiEdit']) {
    test(`[すり抜け] ${toolName} で shell-snapshots`, () => {
      const [d, r] = runGuardFiles(toolName, path.join(tmp, 'home/.claude/shell-snapshots/snapshot-zsh-1.sh'));
      assert.equal(d, 'ask');
      assert.ok(r.includes(SHELL_ENV_REASON), r);
    });
  }

  for (const command of [
    'ls ~/.claude/shell-snapshots',
    'cat ~/.claude/shell-snapshots/*.sh',
    'grep -r PATH ~/.claude/shell-snapshots',
    'cp ~/.claude/shell-snapshots/a.sh /tmp/',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('cp と link の別名（元が環境のファイルでも ask）', () => {
  for (const dir of ['session-env/x', 'shell-snapshots']) {
    for (const command of [
      `cp -l ~/.claude/${dir}/a.sh /tmp/a`,
      `cp --link ~/.claude/${dir}/a.sh /tmp/a`,
      `cp -s ~/.claude/${dir}/a.sh /tmp/a`,
      `cp -al ~/.claude/${dir.split('/')[0]} /tmp/e`,
      `link ~/.claude/${dir}/a.sh /tmp/a`,
    ]) {
      test(`[すり抜け] ${command}`, () => expectAsk(command));
    }
  }
});

describe('リンクを通した書き込み', () => {
  const home = path.join(tmp, 'link-home');
  mkdirSync(path.join(home, '.claude/session-env/0a1b'), { recursive: true });
  const link = path.join(tmp, 'link');
  symlinkSync(path.join(home, '.claude/session-env'), link);

  test('[すり抜け] session-env を指すリンクの下のファイル', () => expectAsk(`echo x >> ${link}/0a1b/a.sh`));
  test('[すり抜け] リンクの下のまだ無いディレクトリのファイル', () => expectAsk(`echo x >> ${link}/new/b.sh`));
  test('[すり抜け] cp でリンクの下へ', () => expectAsk(`cp /tmp/x.sh ${link}/0a1b/`));
  for (const command of ['ln -s ~/.claude /tmp/c', 'ln -s "$CLAUDE_CONFIG_DIR" /tmp/c', 'ln -s /home/u/.claude /tmp/c', 'ln -s /home/u/.claude/ /tmp/c']) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  test('[通す] リンクの無いほかの場所', () => expectAllow(`echo x >> ${path.join(tmp, 'plain.sh')}`));
});

describe('glob', () => {
  for (const command of [
    // dotglob と GLOBIGNORE を付けると * が先頭の点にも当たる
    'echo x >> ~/*claude/se*-env/0a1b/a.sh',
    // 親が .claude でない場所（CLAUDE_CONFIG_DIR=/opt/cfg）
    'echo x >> /opt/cfg/se*-env/0a1b/a.sh',
    `env -C ~/.claude bash -c 'echo x >> se*-env/0a1b/a.sh'`,
    'echo x >> ~/.claude/shell-snap*/a.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of ['echo x > /tmp/*/x', 'echo x > /tmp/s*/x']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('awk の本文', () => {
  for (const tool of ['awk', 'gawk', 'mawk']) {
    for (const command of [
      `${tool} 'BEGIN{print "x" > "/root/.claude/session-env/0a1b/a.sh"}'`,
      `${tool} 'BEGIN{print "x" >> ENVIRON["CLAUDE_ENV_FILE"]}'`,
      `${tool} 'BEGIN{print "x" > "/root/.claude/shell-snapshots/a.sh"}'`,
    ]) {
      test(`[すり抜け] ${command}`, () => expectAsk(command));
    }
  }
});

describe('書庫の展開', () => {
  for (const command of [
    'tar -xf /tmp/a.tar -C ~/.claude/session-env/0a1b',
    'cd ~/.claude && tar -xf /tmp/a.tar',
    'cd ~ && tar xf /tmp/a.tar',
    'bsdtar -xf /tmp/a.tar -C ~/.claude',
    'unzip /tmp/a.zip -d ~/.claude/session-env/0a1b',
    'cd ~/.claude && unzip /tmp/a.zip',
    'cd ~/.claude && cpio -i < /tmp/a.cpio',
    '7z x /tmp/a.7z -o"$HOME/.claude"',
    '7z e /tmp/a.7z -o~/.claude/session-env/0a1b',
    'tar -xf /tmp/a.tar -C ~/.claude/shell-snapshots',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('cd の戻り', () => {
  for (const command of [
    'cd ~/.claude/session-env/x && cd / && cd - && echo x >> a.sh',
    'pushd ~/.claude/session-env/x && pushd / && popd && echo x >> a.sh',
    'cd ~/.claude/shell-snapshots && cd / && cd - && echo x >> a.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('env -C', () => {
  for (const command of [
    'env -C ~/.claude/session-env/0a1b tee b.sh',
    // --chdir=~ は bash が ~ を展開しない（名前が代入の形でない）ので、$HOME で書く
    `env --chdir="$HOME/.claude/session-env/0a1b" sh -c 'echo x >> b.sh'`,
    `env --chdir ~/.claude/session-env/0a1b sh -c 'echo x >> b.sh'`,
    'env -C ~/.claude/shell-snapshots tee b.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('パイプでインタープリタに渡す本文', () => {
  for (const command of [
    `echo "open('/root/.claude/session-env/a','w').write('x')" | python3`,
    `echo 'require("fs").appendFileSync(process.env.CLAUDE_ENV_FILE,"x")' | node`,
    `printf '%s' "open('/root/.claude/shell-snapshots/a.sh','a').write('x')" | python3 -`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('表に無い道具とインタープリタ', () => {
  for (const command of [
    'sort -o ~/.claude/session-env/0a1b/a.sh /tmp/x',
    'openssl enc -in /tmp/x -out ~/.claude/session-env/0a1b/a.sh',
    `sed -n 'w /root/.claude/session-env/0a1b/a.sh' /tmp/x`,
    `gawk -i inplace '{print}' ~/.claude/session-env/0a1b/a.sh`,
    `yq -i '.a=1' ~/.claude/session-env/0a1b/a.sh`,
    'split -l 1 /tmp/x ~/.claude/session-env/0a1b/',
    'zip ~/.claude/session-env/0a1b/a.sh /tmp/x',
    'busybox cp /tmp/x ~/.claude/session-env/0a1b/a.sh',
    'sort -o ~/.claude/shell-snapshots/a.sh /tmp/x',
    `tsx -e 'require("fs").appendFileSync(process.env.CLAUDE_ENV_FILE, "x")'`,
    `ts-node -e 'require("fs").appendFileSync("/root/.claude/session-env/0a1b/a.sh", "x")'`,
    `python3.12 -c 'open("/root/.claude/session-env/0a1b/a.sh","a").write("x")'`,
    `nodejs -e 'require("fs").appendFileSync(process.env.CLAUDE_ENV_FILE, "x")'`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('止めすぎを直す（読むだけ、コピーの元、スクリプトの引数）', () => {
  for (const command of [
    'cd ~/.claude/session-env/x && ls > /dev/null',
    'cd ~/.claude/session-env/x && cat a.sh > /tmp/o',
    'cp "$CLAUDE_ENV_FILE" /tmp/backup/',
    'cp -t /tmp ~/.claude/session-env/x/a.sh',
    'cp ~/.claude/shell-snapshots/a.sh /tmp/',
    'node scripts/foo.mjs session-env',
    'cd ~/.claude/shell-snapshots && cat a.sh > /tmp/o',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('Write の先がまだ無いファイルを指すリンク', () => {
  const home = path.join(tmp, 'dangling-home');
  mkdirSync(path.join(home, '.claude/session-env/0a1b'), { recursive: true });
  const dangling = path.join(tmp, 'dangling.sh');
  symlinkSync(path.join(home, '.claude/session-env/0a1b/new.sh'), dangling);

  for (const toolName of ['Write', 'Edit', 'MultiEdit']) {
    test(`[すり抜け] ${toolName} の先がまだ無い session-env のファイルを指すリンク`, () => {
      const [d, r] = runGuardFiles(toolName, dangling);
      assert.equal(d, 'ask');
      assert.ok(r.includes(SHELL_ENV_REASON), r);
    });
  }
});

describe('guard-files.mjs の判定の順（deny を優先）', () => {
  const worktree = path.resolve(hooks, '../..');

  test('[完了条件] src/routes/session-env/+page.server.ts への Write は deny のまま', () => {
    const [d] = runGuardFiles('Write', path.join(worktree, 'src/routes/session-env/+page.server.ts'), {
      cwd: worktree,
      env: { CLAUDE_PROJECT_DIR: worktree },
    });
    assert.equal(d, 'deny');
  });

  test('[完了条件] main の作業コピーの session-env を含むパスへの Write は deny のまま', () => {
    const repo = path.join(tmp, 'main-repo');
    mkdirSync(repo);
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanEnv });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    };
    git(['init', '-q', '-b', 'main']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const [d] = runGuardFiles('Write', path.join(repo, 'docs/session-env/x.md'), { cwd: repo, env: { CLAUDE_PROJECT_DIR: repo } });
    assert.equal(d, 'deny');
    const [d2] = runGuardFiles('Write', path.join(repo, 'docs/shell-snapshots/x.md'), { cwd: repo, env: { CLAUDE_PROJECT_DIR: repo } });
    assert.equal(d2, 'deny');
  });
});

describe('完了条件（再現の手順）', () => {
  for (const command of [
    `echo '${SET}' >> ~/.claude/session-env/0a1b/x.sh`,
    `echo 'export GH_REPO=other/repo' >> "$CLAUDE_ENV_FILE"`,
    `echo '${SET}' | tee -a /root/.claude/session-env/0a1b/x.sh`,
  ]) {
    test(`[完了条件] ${command}`, () => expectAsk(command));
  }
  test('[完了条件] Write で session-env', () => {
    const [d, r] = runGuardFiles('Write', path.join(tmp, 'home/.claude/session-env/0a1b/x.sh'));
    assert.equal(d, 'ask');
    assert.ok(r.includes(SHELL_ENV_REASON), r);
  });
  for (const command of ['ls ~/.claude/session-env', 'cat ~/.claude/session-env/*/*.sh', 'grep -r PATH ~/.claude/session-env', 'echo $CLAUDE_ENV_FILE']) {
    test(`[完了条件] [通す] ${command}`, () => expectAllow(command));
  }
});
