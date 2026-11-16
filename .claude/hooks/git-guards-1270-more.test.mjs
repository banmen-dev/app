// #1270: 環境のファイル（session-env、shell-snapshots）への書き込みの、形の幅を確かめる追加のテスト。
// すり抜けは ask、読むだけと無関係な形は通す。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command, cwd = '/repo') => judgeBash(command, { cwd, branchOf: () => '1270-session-env', env: {} });
const expectAsk = (command, cwd) => {
  assert.deepEqual(verdict(command, cwd), ['ask', SHELL_ENV_REASON], command);
};
// 守る仕組みの .claude や、道具を判定できない前置きの規則が先に当たる形は、理由が別でも ask であればよい
const expectAskAny = (command) => assert.equal(verdict(command)?.[0], 'ask', command);
const expectAllow = (command, cwd) => assert.equal(verdict(command, cwd), null, command);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-more-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('glob の形', () => {
  for (const command of [
    'echo x >> ~/?claude/session-env/a.sh',
    'echo x >> ~/[.]claude/session-env/a.sh',
    'echo x >> ~/.claude/s?ssion-env/a.sh',
    'echo x >> ~/.claude/sh*/a.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of ['echo x > /tmp/ses*/x', 'echo x > /tmp/*/x', 'echo x > /tmp/s*/x']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('awk のプログラムと sed の w', () => {
  for (const command of [
    `awk 'BEGIN{printf "x" >> "/root/.claude/session-env/a"}'`,
    `mawk -e 'BEGIN{print "x" > ENVIRON["CLAUDE_ENV_FILE"]}'`,
    `sed 's/a/b/w /root/.claude/session-env/x/a.sh' /tmp/in`,
    'sort -o~/.claude/session-env/a.sh /tmp/in',
    'sort --output=/root/.claude/session-env/a /tmp/in',
    'echo x | busybox tee ~/.claude/session-env/a',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    `awk '{print}' ~/.claude/session-env/x/a.sh`,
    `sed -n '/session-env/p' /tmp/x`,
    `sed -n 's/a/b/p' ~/.claude/session-env/a.sh`,
    'sort /tmp/in -o /tmp/out',
    'zip /tmp/a.zip ~/.claude/session-env/a.sh',
    'split -l 1 ~/.claude/session-env/a.sh /tmp/p',
    'yq .a ~/.claude/session-env/a.yml',
    'busybox ls ~/.claude/session-env',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('ほかの規則が先に当たっても ask', () => {
  for (const command of ['busybox sh -c "echo x > ~/.claude/session-env/a"', 'tar xf /tmp/a.tar --directory=~/.claude', 'cp -r /tmp/session-env ~/.claude/']) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
});

describe('書庫の展開', () => {
  for (const command of [
    'tar xf /tmp/a.tar -C ~',
    'unzip -o /tmp/a.zip -d ~/.claude',
    'cd ~/.claude && 7z x /tmp/a.7z',
    'bsdtar xf /tmp/a.tar -C ~/.claude/shell-snapshots',
    'cpio -id -D ~/.claude < /tmp/a.cpio',
    'cpio -p ~/.claude/session-env/x < /tmp/list',
    'env -C ~/.claude busybox tar xf /tmp/a.tar',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'tar -tf /tmp/a.tar',
    'tar xf /tmp/a.tar',
    'tar xf /tmp/a.tar -C /tmp/x',
    'unzip -l /tmp/a.zip',
    'unzip /tmp/a.zip -d /tmp/x',
    '7z l /tmp/a.7z',
    'cpio -i < /tmp/a.cpio',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('cd の戻りと env -C の入れ子', () => {
  for (const command of [
    'cd ~/.claude/session-env/x; cd ..; cd -; echo x > a.sh',
    'pushd ~/.claude/shell-snapshots && popd && tee a.sh',
    'cd ~/.claude/session-env/x && bash -c "cd / && cd - && echo x >> a.sh"',
    'env -C ~/.claude env -C session-env tee a.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of ['cd ~/.claude/session-env/x && cd - && echo x > /dev/null', 'cd /tmp && echo x > a.sh', 'cd ~/work && cd - && echo x > a.sh']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('本文のインタープリタ', () => {
  for (const command of [
    `echo "process.env.CLAUDE_ENV_FILE" | node`,
    `ruby3 -e 'File.write("/root/.claude/session-env/a","x")'`,
    `python3.11 - <<EOF\nopen("/root/.claude/session-env/a","w")\nEOF`,
    `ts-node -p 'require("fs").writeFileSync(process.env.CLAUDE_ENV_FILE,"x")'`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of ['node scripts/foo.mjs session-env', 'python3 tools/x.py ~/.claude/session-env', 'python3.12 tools/x.py ~/.claude/session-env']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('リンクと別名', () => {
  for (const command of [
    'link /tmp/x ~/.claude/session-env/a',
    'cp --symbolic-link ~/.claude/session-env/a /tmp/a',
    'ln -sf /tmp/x ~/.claude/shell-snapshots/snapshot.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of ['cp -r ~/.claude/session-env /tmp/e', 'rsync -a ~/.claude/session-env/ /tmp/e/', 'ln -s /tmp/a /tmp/b', 'cp -a /tmp/a /tmp/b']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }

  const home = path.join(tmp, 'home');
  mkdirSync(path.join(home, '.claude/session-env/0a1b'), { recursive: true });
  mkdirSync(path.join(tmp, 'work'));
  symlinkSync(path.join(home, '.claude'), path.join(tmp, 'work/c'));
  test('[すり抜け] 作業場所の相対のリンクを通した書き込み', () => expectAsk('echo x >> c/session-env/0a1b/a.sh', path.join(tmp, 'work')));
  test('[通す] リンクを通さない相対の書き込み', () => expectAllow('echo x >> d/a.sh', path.join(tmp, 'work')));
});

describe('ホームを引けないとき', () => {
  test('例外を投げず、書き込みの判定を続ける', () => {
    const original = os.homedir;
    os.homedir = () => {
      throw new Error('no home');
    };
    try {
      assert.doesNotThrow(() => verdict('echo x >> ~/a.sh'));
      expectAsk('echo x >> ~/.claude/session-env/a.sh');
      assert.doesNotThrow(() => verdict('tar xf /tmp/a.tar -C ~'));
    } finally {
      os.homedir = original;
    }
  });
});
