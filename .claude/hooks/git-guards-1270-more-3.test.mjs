// #1270: break-2 の指摘（ホームへの再帰コピー、uniq と xxd の位置引数、$PWD と ~-、リンクの後の ..、patch と git apply、
// checkout-index --prefix、sqlite3 の .output、ruby -i、curl の --stderr と %output{}、awk -f /dev/stdin）の周辺で、
// 止める形と通す形を確かめる追加のテスト。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command, cwd = '/repo') => judgeBash(command, { cwd, branchOf: () => '1270-session-env', env: {} });
const expectAsk = (command, cwd) => assert.deepEqual(verdict(command, cwd), ['ask', SHELL_ENV_REASON], command);
const expectAllow = (command, cwd) => assert.equal(verdict(command, cwd), null, command);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-more-3-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ENV_FILE = '~/.claude/session-env/a/x.sh';

describe('uniq と xxd の位置引数', () => {
  for (const command of [
    `uniq -c -f 1 -- /tmp/x ${ENV_FILE}`,
    `uniq --skip-chars=2 /tmp/x ${ENV_FILE}`,
    `uniq --check-chars 3 /tmp/x ${ENV_FILE}`,
    `xxd -groupsize 2 -r /tmp/x.hex ${ENV_FILE}`,
    `xxd -c8 -r /tmp/x.hex ${ENV_FILE}`,
    `xxd -s -4 /tmp/x.bin ${ENV_FILE}`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    `uniq -c ${ENV_FILE}`,
    `uniq -c - < ${ENV_FILE}`,
    `uniq ${ENV_FILE} -`,
    `xxd -autoskip ${ENV_FILE}`,
    `xxd -r - /tmp/o < ${ENV_FILE}`,
    `xxd -s 4 -l 8 ${ENV_FILE} -`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('$PWD と ~-', () => {
  for (const command of ['cd ~/.claude/shell-snapshots && echo x >> $PWD/a.sh', 'cd ~/.claude/session-env/x && echo x >> ${PWD}', 'cd ~/.claude/session-env/x && cd /tmp && cp /tmp/x ~-/']) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of ['cd /tmp && echo x > $PWD/a.sh', 'cd /tmp && echo x > ~-/a.sh', 'cd ~/.claude/session-env/x && cat $PWD/a.sh > /tmp/o', 'echo x > ~-/a.sh']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('リンクの後の ..', () => {
  const home = path.join(tmp, 'home');
  mkdirSync(path.join(home, '.claude/session-env/0a1b/sub'), { recursive: true });
  mkdirSync(path.join(tmp, 'work/plain'), { recursive: true });
  symlinkSync(path.join(home, '.claude/session-env/0a1b/sub'), path.join(tmp, 'work/deep'));
  // 相対のリンクの向き先の .. も、リンクの置かれた場所から辿る
  symlinkSync('../home/.claude/session-env/0a1b', path.join(tmp, 'work/rel'));
  test('[すり抜け] 相対のリンクを通した ..', () => expectAsk('echo x >> rel/sub/../x.sh', path.join(tmp, 'work')));
  test('[すり抜け] deep/../ の下の相対のパス', () => expectAsk('tee deep/../y.sh', path.join(tmp, 'work')));
  test('[通す] リンクでない名前の ..', () => expectAllow('echo x >> plain/../x.sh', path.join(tmp, 'work')));
  test('[通す] 輪になったリンク', () => {
    symlinkSync(path.join(tmp, 'work/loop'), path.join(tmp, 'work/loop'));
    expectAllow('echo x >> loop/x.sh', path.join(tmp, 'work'));
  });
});

describe('ホームと .claude への再帰のコピー', () => {
  for (const command of ['rsync -a /tmp/h/ $HOME/', 'cp -a /tmp/h/. ~', 'cd ~/.claude && rsync -r /tmp/h/ .']) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
  for (const command of ['cp /tmp/x ~/', 'cp /tmp/x ~/work/', 'cd ~/work && cp -r /tmp/h/. .', 'cp -r ~ /tmp/bk']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('patch、git apply、checkout-index', () => {
  for (const command of [
    'patch -d ~/.claude/shell-snapshots -p0 -i /tmp/p',
    'patch -o ~/.claude/session-env/a/x.sh /tmp/x /tmp/p',
    'patch --dir=/root/.claude/session-env/x -p1 < /tmp/p',
    'cd ~ && patch -p1 < /tmp/p',
    'git apply --directory=/root/.claude/session-env /tmp/p',
    'git -C ~/.claude/shell-snapshots apply --apply /tmp/p',
    'git checkout-index --prefix /root/.claude/shell-snapshots/ -a',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
  for (const command of [
    'patch -p1 < /tmp/p',
    'cd ~/.claude/session-env/x && patch --dry-run -p1 < /tmp/p',
    'cd ~/.claude/session-env/x && git apply --check /tmp/p',
    'git -C /repo apply /tmp/p',
    'git checkout-index --prefix=/tmp/x/ -a',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('sqlite3、ruby、curl、awk', () => {
  for (const command of [
    `sqlite3 /tmp/db ".backup main ~/.claude/session-env/a/x.sh"`,
    `sqlite3 /tmp/db <<'EOF'\n.output ~/.claude/shell-snapshots/a.sh\nselect 1;\nEOF`,
    `ruby -i.bak -pe 'x' ${ENV_FILE}`,
    `ruby3.3 -pi -e 'x' ${ENV_FILE}`,
    `curl -s --stderr=/root/.claude/session-env/a/x.sh https://example.com`,
    `curl -s -w '%output{>>/root/.claude/shell-snapshots/a.sh}x' https://example.com`,
    `awk -f /dev/stdin <<'E'\nBEGIN{print "x" > "/root/.claude/shell-snapshots/a.sh"}\nE`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    `sqlite3 /tmp/db '.tables'`,
    `sqlite3 /tmp/db '.output stdout' 'select 1'`,
    `ruby -rfileutils -e 'puts 1' ${ENV_FILE}`,
    `ruby scripts/x.rb ${ENV_FILE}`,
    `curl -s -w '%{http_code}' https://example.com`,
    `curl -s --stderr /tmp/e https://example.com`,
    `awk -f scripts/x.awk ${ENV_FILE}`,
    `awk -f /dev/stdin /tmp/in <<'E'\nBEGIN{print 1}\nE`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

function expectAskAny(command, cwd) {
  assert.equal(verdict(command, cwd)?.[0], 'ask', command);
}
