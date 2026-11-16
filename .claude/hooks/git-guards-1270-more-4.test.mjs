// #1270: break-3 の指摘（git が作業コピーとして書く形、curl の書き先、sqlite3 の省略形と writefile、-o で先を名指す道具、
// ditto、~+、~ユーザー名、ホームの祖先への展開、ruby の -C と -0777pi、patch --prefix=）の周辺で、止める形と通す形を確かめる追加のテスト。
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '1270-session-env', env: {} });
const expectAsk = (command) => assert.deepEqual(verdict(command), ['ask', SHELL_ENV_REASON], command);
// git の別の規則や守る仕組みの .claude の規則が先に当たる形は、理由が別でも ask であればよい
const expectAskAny = (command) => assert.equal(verdict(command)?.[0], 'ask', command);
const expectAllow = (command) => assert.equal(verdict(command), null, command);

const ENV_DIR = '~/.claude/session-env/a';

describe('git が作業コピーとして書く先', () => {
  for (const command of [
    `git clone -b main --depth 1 /tmp/evil ${ENV_DIR}`,
    `cd ${ENV_DIR} && git clone /tmp/evil`,
    `gh repo clone o/evil`.replace('gh', `cd ${ENV_DIR} && gh`),
    `git worktree move /tmp/wt ${ENV_DIR}`,
    `git -C /tmp/g worktree add -b new ${ENV_DIR}/x`,
    `git --work-tree=${ENV_DIR} checkout -f`,
    `git -C ${ENV_DIR} --git-dir=/tmp/g/.git reset --hard`,
    `git clone --separate-git-dir ${ENV_DIR}/g /tmp/evil /tmp/x`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
  for (const command of [
    'git clone https://github.com/o/r /tmp/r',
    'git clone --depth 1 https://github.com/o/r',
    'gh repo clone o/r /tmp/r',
    'git worktree add ../x evil',
    'git -C ~/work/proj worktree add ../x evil',
    'git --git-dir=/tmp/g/.git checkout-index -a',
    'git --work-tree=/tmp/x status',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('curl、sqlite3、-o で先を名指す道具', () => {
  for (const command of [
    `curl -s -c ${ENV_DIR}/jar.txt https://example.com`,
    `curl -s --trace ${ENV_DIR}/t.txt https://example.com`,
    `curl -s --etag-save ${ENV_DIR}/e https://example.com`,
    `curl -s -K - <<'E'\ndump-header = "/root/.claude/shell-snapshots/h"\nE`,
    `printf 'output = "/root/.claude/session-env/a/x.sh"' | curl -s -K -`,
    `sqlite3 :memory: "select writefile(\\"/root/.claude/session-env/a/x.sh\\", 'x')"`,
    `sqlite3 :memory: ".ba main /root/.claude/session-env/a/x.sh"`,
    `echo '.once /root/.claude/shell-snapshots/a.sh' | sqlite3`,
    `base64 -o ${ENV_DIR}/x.sh -i /tmp/in`,
    `uudecode --output-file=${ENV_DIR}/x.sh /tmp/x.uu`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'curl -s -c /tmp/jar.txt https://example.com',
    `curl -s -K - <<'E'\noutput = "/tmp/x"\nE`,
    `echo '.output /tmp/o' | sqlite3`,
    `sqlite3 :memory: ".open /tmp/x.db"`,
    `sqlite3 :memory: "select writefile('/tmp/o', 'x')"`,
    'base64 -d -o /tmp/o /tmp/in',
    'sdiff -o /tmp/merged /tmp/a /tmp/b',
    `base64 -i ${ENV_DIR}/x.sh`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('ホームと作業場所の綴り、ruby、patch', () => {
  const parent = path.dirname(os.homedir());
  for (const command of [
    'ditto ~/work/a ~root',
    `cd ~/.claude/session-env/x && cp -t ~+ /tmp/a.sh`,
    `cd ~/.claude/shell-snapshots && install /tmp/a.sh ~+/a.sh`,
    `tar xf /tmp/a.tar --directory=${parent}`,
    'tar xf /tmp/a.tar -C /',
    'cd ~root && unzip /tmp/a.zip',
    `ruby -Cdir -e 'x'`.replace('-Cdir', `-C${ENV_DIR}`),
    `ruby -0 -pi.bak -e 'x' ${ENV_DIR}/x.sh`,
    `patch -B ${ENV_DIR}/ -b -p0 < /tmp/p`,
    `patch --prefix ${ENV_DIR}/ -p0 < /tmp/p`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
  for (const command of [
    'ditto ~/work/a ~/work/b',
    'cd ~/work && ditto a b',
    'tar xf /tmp/a.tar -C /tmp',
    `tar xf /tmp/a.tar -C ${os.homedir()}/work`,
    "ruby -C ~/work -e 'x'",
    "ruby -0777 -e 'puts 1' ~/.claude/session-env/a/x.sh",
    'patch -b --prefix=/tmp/backup/ -p1 < /tmp/p',
    'cd /tmp && cp -t ~+ /tmp/a.sh',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});
