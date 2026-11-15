// #1270: PR のレビューの指摘（行き先が決まらない cd、ハードリンクで写す形、sed の e、cwd が初めから環境のファイルの下、
// ホームを引けない Write、guard-files の判定の合成、awk -f の読むだけ、別の規則に紛れないテスト）を確かめる追加のテスト。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command, cwd = '/repo') => judgeBash(command, { cwd, branchOf: () => '1270-session-env', env: {} });
const expectAsk = (command, cwd) => assert.deepEqual(verdict(command, cwd), ['ask', SHELL_ENV_REASON], command);
const expectAllow = (command, cwd) => assert.equal(verdict(command, cwd), null, command);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-review-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ENV_DIR = '~/.claude/session-env/x';

describe('行き先が字面で決まらない cd の後（一度環境のファイルのディレクトリに入っていれば相対の書き込みを止める）', () => {
  for (const command of [
    `cd ${ENV_DIR} && cd /tmp && cd ~1 && echo x > a.sh`,
    `cd ${ENV_DIR} && cd /tmp && cd ~-/ && echo x > a.sh`,
    `cd ${ENV_DIR} && cd /tmp && cd "$OLDPWD/" && echo x > a.sh`,
    `cd ${ENV_DIR} && cd /tmp && cd -Pe - && echo x > a.sh`,
    `cd ${ENV_DIR} && pushd /tmp && pushd -n +1 && echo x > a.sh`,
    `cd ${ENV_DIR} && cd /tmp/* && echo x > a.sh`,
    `cd ~/.claude/shell-snapshots && cd /tmp && popd && echo x > a.sh`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'cd ~/work && cd ~1 && echo x > a.sh',
    'cd ~/work && cd "$OLDPWD/" && echo x > a.sh',
    `cd ${ENV_DIR} && cd "$TMPDIR" && echo x > a.sh`,
    `cd ${ENV_DIR} && cd /tmp && echo x > a.sh`,
    `cd ${ENV_DIR} && cd ~/work && echo x > a.sh`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('フックの cwd が初めから環境のファイルのディレクトリの下にあるとき', () => {
  const cwd = '/root/.claude/session-env/0a1b';
  for (const command of ['echo x > a.sh', 'cd - && echo x > a.sh', 'cd /tmp/* && echo x > a.sh', 'cd ~1 && echo x > a.sh', 'popd && tee a.sh < /tmp/x']) {
    test(`[すり抜け] cwd=${cwd}: ${command}`, () => expectAsk(command, cwd));
  }
  for (const command of ['cd /tmp && echo x > a.sh', 'echo x > /tmp/a.sh', 'cat a.sh > /tmp/o']) {
    test(`[通す] cwd=${cwd}: ${command}`, () => expectAllow(command, cwd));
  }
});

describe('ハードリンクで写す形（元も見る）', () => {
  for (const command of [
    `rsync -a --link-dest=${ENV_DIR} /tmp/src/ /tmp/dst/`,
    `cd ${ENV_DIR} && find . | cpio -pdl /tmp/dst`,
    `cd ${ENV_DIR} && find . | cpio -pl /tmp/dst`,
    `pax -rwl ${ENV_DIR} /tmp/dst`,
    `pax -rw -l ~/.claude/shell-snapshots /tmp/dst`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'rsync -a --link-dest=/tmp/prev /tmp/src/ /tmp/dst/',
    `cd ${ENV_DIR} && find . | cpio -pd /tmp/dst`,
    'find . | cpio -pdl /tmp/dst',
    'pax -rw /tmp/src /tmp/dst',
    `rsync -a ${ENV_DIR}/ /tmp/dst/`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('sed の e コマンドと s///e フラグ', () => {
  for (const command of [
    String.raw`sed 's|^|echo x >> /root/.claude/session-env/a/x.sh #|e' /tmp/in`,
    String.raw`sed 's/^/echo x >> ~\/.claude\/session-env\/a\/x.sh #/e' /tmp/in`,
    String.raw`sed -e '1e echo x >> "$CLAUDE_ENV_FILE"' /tmp/in`,
    `sed -n e ~/.claude/session-env/a/x.sh`,
    `sed -e '/x/e' -e p ~/.claude/shell-snapshots/a.sh`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    `sed 's/a/b/' ~/.claude/session-env/a/x.sh`,
    'sed -n e /tmp/in',
    'sed s/a/b/e /tmp/in',
    `sed -n '/session-env/p' /tmp/in`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('awk -f の後の最初のファイル引数は本文ではない', () => {
  for (const command of ['awk -f /tmp/x.awk ~/.claude/session-env/a/x.sh', 'awk -F: -f x.awk ~/.claude/shell-snapshots/a.sh', 'gawk --file=x.awk ~/.claude/session-env/a/x.sh']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('別の規則に紛れない形（SHELL_ENV_REASON で止まる）', () => {
  for (const command of [
    'tar xf /tmp/a.tar --directory=~/.claude/shell-snapshots',
    'tar xf /tmp/a.tar --directory=~',
    'cd ~/.claude && cp -r /tmp/session-env .',
    'cd ~/.claude && cp -r /tmp/x/. .',
    'busybox cp /tmp/x ~/.claude/session-env/a/x.sh',
    'echo x | busybox tee ~/.claude/shell-snapshots/a.sh',
    'cd ~/.claude/session-env/a && busybox tee a.sh < /tmp/x',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('guard-files.mjs', () => {
  const hooks = import.meta.dirname;
  const worktree = path.resolve(hooks, '../..');
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !['CLAUDE_ENV_FILE', 'CLAUDE_CODE_REMOTE'].includes(key)));
  const run = (filePath, { cwd = tmp, nodeArgs = [] } = {}) => {
    const result = spawnSync(process.execPath, [...nodeArgs, path.join(hooks, 'guard-files.mjs')], {
      input: JSON.stringify({ tool_name: 'Write', cwd, tool_input: { file_path: filePath, content: 'export A=1' } }),
      encoding: 'utf8',
      env: { ...cleanEnv, CLAUDE_PROJECT_DIR: '' },
    });
    return { status: result.status, stderr: result.stderr, output: result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null };
  };

  test('ホームを引けなくても落ちずに、~ で始まる環境のファイルは書かれたパスのまま止める', () => {
    const preload = path.join(tmp, 'no-home.mjs');
    writeFileSync(preload, "import os from 'node:os';\nos.homedir = () => {\n  throw new Error('no home');\n};\n");
    const nodeArgs = ['--import', pathToFileURL(preload).href];
    const env = run('~/.claude/session-env/a/x.sh', { nodeArgs });
    assert.equal(env.status, 0, env.stderr);
    assert.equal(env.output?.permissionDecision, 'ask');
    const plain = run('~/notes/a.md', { nodeArgs });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.output, null);
  });

  test('ask が 2 つ出たときは、理由の文を両方つなぐ', () => {
    const { output } = run(path.join(worktree, '.claude/hooks/session-env/x.mjs'), { cwd: worktree });
    assert.equal(output.permissionDecision, 'ask');
    assert.ok(output.permissionDecisionReason.includes(SHELL_ENV_REASON), output.permissionDecisionReason);
    assert.ok(output.permissionDecisionReason.includes('守る仕組み（フック）'), output.permissionDecisionReason);
  });

  test('deny と ask が両方出たときは deny を採る', () => {
    const { output } = run(path.join(worktree, 'src/routes/session-env/+page.server.ts'), { cwd: worktree });
    assert.equal(output.permissionDecision, 'deny');
  });

  test('1 つだけのときは理由の文をそのまま使う', () => {
    mkdirSync(path.join(tmp, 'home/.claude/session-env/0a1b'), { recursive: true });
    const { output } = run(path.join(tmp, 'home/.claude/session-env/0a1b/x.sh'));
    assert.equal(output.permissionDecision, 'ask');
    assert.equal(output.permissionDecisionReason, `${SHELL_ENV_REASON}（.claude/hooks/file-rules.mjs）`);
  });
});
