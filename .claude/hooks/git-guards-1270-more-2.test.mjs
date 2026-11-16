// #1270: break-1 の指摘（source の標準入力、coproc、awk -v、表に無いインタープリタ、2 つ目の引数の道具、git config -f、
// 引数 1 つの ln、cd の後の再帰コピー、CLAUDE_ENV_FILE の値の照合）の周辺で、止める形と通す形を確かめる追加のテスト。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command, env = {}) => judgeBash(command, { cwd: '/repo', branchOf: () => '1270-session-env', env });
const expectAsk = (command, env) => assert.deepEqual(verdict(command, env), ['ask', SHELL_ENV_REASON], command);
const expectAllow = (command, env) => assert.equal(verdict(command, env), null, command);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-more-2-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('source と coproc', () => {
  for (const command of [
    `source /dev/stdin <<< 'echo x >> "$CLAUDE_ENV_FILE"'`,
    `coproc cp /tmp/x ~/.claude/shell-snapshots/a.sh`,
    `coproc tee -a ~/.claude/session-env/a/x.sh`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [`source ./env.sh <<< 'echo x >> ~/.claude/session-env/a'`, `coproc cat ~/.claude/session-env/a/x.sh`, 'coproc sleep 1']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('awk -v とインタープリタの名前', () => {
  for (const command of [
    `awk -vf=/root/.claude/session-env/a/x.sh 'BEGIN{print "x" > f}'`,
    `gawk --assign f=/root/.claude/shell-snapshots/a.sh 'BEGIN{print "x" > f}'`,
    `lua5.4 -e 'io.open("/root/.claude/session-env/a/x.sh","a")'`,
    `luajit -e 'io.open(os.getenv("CLAUDE_ENV_FILE"),"a")'`,
    `Rscript -e 'cat("x", file=Sys.getenv("CLAUDE_ENV_FILE"), append=TRUE)'`,
    `deno eval 'Deno.writeTextFileSync(Deno.env.get("CLAUDE_ENV_FILE"),"x")'`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [`awk -v n=1 '{print n}' ~/.claude/session-env/a/x.sh`, `lua scripts/x.lua session-env`, 'deno run scripts/x.ts session-env']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('2 つ目の引数に書く道具と git config -f', () => {
  for (const command of [
    'uniq -f 1 /tmp/x ~/.claude/shell-snapshots/a.sh',
    'xxd -c 8 -r /tmp/x.hex ~/.claude/session-env/a/x.sh',
    'git config -f ~/.claude/session-env/a/x.sh --unset a.b',
    'git -C /repo config --file=~/.claude/session-env/a/x.sh a.b c',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'uniq ~/.claude/session-env/a/x.sh /tmp/o',
    'uniq ~/.claude/session-env/a/x.sh',
    'xxd ~/.claude/session-env/a/x.sh',
    'git config -f ~/.claude/session-env/a/x.sh --get a.b',
    'git config --file ~/.claude/session-env/a/x.sh --list',
    'git config -f /tmp/x.cfg a.b c',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('cd の後の ln と再帰コピー', () => {
  for (const command of ['cd ~/.claude/shell-snapshots && ln -s /tmp/x.sh', 'cd ~/.claude/session-env/x && ln -sf /tmp/x.sh']) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  test('[すり抜け] cd ~/.claude && cp -r /tmp/se/. .', () => assert.equal(verdict('cd ~/.claude && cp -r /tmp/se/. .')?.[0], 'ask'));
  for (const command of ['cd /tmp && ln -s /tmp/x.sh', 'cd ~/work && cp -r /tmp/se/. .', 'cd ~/.claude && cp /tmp/x.json settings-copy.json']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('CLAUDE_ENV_FILE の値の照合', () => {
  const dirPath = path.join(tmp, 'd');
  mkdirSync(dirPath);
  const envFile = path.join(dirPath, 'claude-env.sh');
  writeFileSync(envFile, '');
  const env = { CLAUDE_ENV_FILE: envFile };
  for (const command of [`cp /tmp/claude-env.sh ${dirPath}/`, `mv /tmp/claude-env.sh ${dirPath}`, `cp -t ${dirPath} /tmp/claude-env.sh`, `install /tmp/claude-env.sh ${dirPath}/`]) {
    test(`[すり抜け] ${command.replaceAll(tmp, '$T')}`, () => expectAsk(command, env));
  }
  for (const command of [`cp /tmp/other.sh ${dirPath}/`, `cp ${envFile} /tmp/`, `cp -t /tmp ${envFile}`]) {
    test(`[通す] ${command.replaceAll(tmp, '$T')}`, () => expectAllow(command, env));
  }
});
