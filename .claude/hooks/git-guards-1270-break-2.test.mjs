// #1270: 環境のファイル（session-env、shell-snapshots、CLAUDE_ENV_FILE）への書き込みの判定を崩しにいく 2 周目のテスト。
// 保存済みのテスト（shell-env、session-env）、more、more-2、break-1 に無い手口だけを置く。
// [欠陥] の付いたテストは、今の実装で落ちる形。横のコメントに、書き込みが実際に起きること（一時の HOME で bash と zsh を動かして確かめた）と
// 欠陥とみなす根拠を書く。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command, { cwd = '/repo', env = {} } = {}) => judgeBash(command, { cwd, branchOf: () => '1270-session-env', env });
const expectAsk = (command, options) => assert.deepEqual(verdict(command, options), ['ask', SHELL_ENV_REASON], command);
// 守る仕組みの .claude や、道具を判定できない前置きの規則が先に当たる形は、理由が別でも ask であればよい
const expectAskAny = (command, options) => assert.equal(verdict(command, options)?.[0], 'ask', command);
const expectAllow = (command, options) => assert.equal(verdict(command, options), null, command);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-break-2-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('リダイレクトと source の別の形', () => {
  for (const command of [
    // >& の後ろが数字でなければ、標準出力と標準エラーをそのファイルへ書く（bash と zsh）。>>& は zsh の追記
    'echo x >& ~/.claude/session-env/a/x.sh',
    'echo x >&~/.claude/session-env/a/x.sh',
    'echo x >>& ~/.claude/session-env/a/x.sh',
    `source /dev/fd/0 <<< 'echo x >> ~/.claude/session-env/a/x.sh'`,
    `. /proc/self/fd/0 <<< 'echo x >> ~/.claude/session-env/a/x.sh'`,
    `source /dev/stdin <<- E\n\techo x >> ~/.claude/session-env/a/x.sh\nE`,
    `builtin source /dev/stdin <<< 'echo x >> ~/.claude/session-env/a/x.sh'`,
    `command . /dev/stdin <<< 'echo x >> ~/.claude/session-env/a/x.sh'`,
    'coproc command tee -a ~/.claude/session-env/a/x.sh',
    'nohup coproc tee -a ~/.claude/session-env/a/x.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [`coproc cat ~/.claude/shell-snapshots/a.sh`, 'uniq -c - < ~/.claude/session-env/a/x.sh']) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('cd の別の綴り', () => {
  for (const command of [
    'cd ~/.claude/session-env/x; cd /tmp; cd ~-; echo x > a.sh',
    'cd ~/.claude/session-env/x; cd /tmp; cd "$OLDPWD"; echo x > a.sh',
    'cd ~/.claude/session-env/x && echo x > ~+/a.sh',
    'builtin cd ~/.claude/session-env/x && echo x > a.sh',
    'command cd ~/.claude/session-env/x && echo x > a.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  test('[通す] cd ~/.claude/session-env/x && cd "$TMPDIR" && echo x > a.sh', () => expectAllow('cd ~/.claude/session-env/x && cd "$TMPDIR" && echo x > a.sh'));
  // cd の後の "$(pwd)/a.sh" は break-1 の指摘で ask になった。$PWD と ${PWD} はシェルが cd のたびに置く値で、同じ場所を指す
  // （bash と zsh で session-env/a/x.sh ができるのを確かめた）。docs の「見えない形」の「変数を経由した書き込み」は、
  // セッションが自分で置いた変数（f=…; echo >> "$f"）の例で、cd が決める $PWD は「cd の後の相対パス」と同じ筋
  for (const command of ['cd ~/.claude/session-env/x && echo x > $PWD/a.sh', 'cd ~/.claude/session-env/x && echo x > "${PWD}/a.sh"']) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // ~- は直前の作業場所（$OLDPWD）に展開される（bash と zsh で session-env/a/x.sh ができるのを確かめた）。
  // docs の表は cd - の後の相対パスを見るとし、cd ~- の後の相対の書き込みは ask になる。語の先頭の ~- だけ漏れる
  test('[欠陥] cd ~/.claude/session-env/x && cd /tmp && echo x >> ~-/a.sh', () => expectAsk('cd ~/.claude/session-env/x && cd /tmp && echo x >> ~-/a.sh'));
});

describe('書き込みの道具の別のオプション', () => {
  for (const command of [
    'scp /tmp/x ~/.claude/session-env/a/x.sh',
    'echo x | sponge -a ~/.claude/session-env/a/x.sh',
    'install -m 644 /tmp/x ~/.claude/session-env/a/x.sh',
    'patch -d ~/.claude/session-env/x -p0 < /tmp/p',
    'git show HEAD:evil.sh --output=/root/.claude/session-env/x/a.sh',
    'find /tmp -fls ~/.claude/session-env/a/x.sh',
    'find /tmp -fprint0 ~/.claude/session-env/a/x.sh',
    `vim -es -c 'w! /root/.claude/session-env/a/x.sh' -c q /tmp/evil.sh`,
    `vim -es '+w /root/.claude/session-env/a/x.sh' '+q' /tmp/evil.sh`,
    `ex -sc 'w /root/.claude/session-env/a/x.sh|q' /tmp/evil.sh`,
    `perl -pi.bak -e 's/a/b/' ~/.claude/session-env/a/x.sh`,
    `sed -ne 'w /root/.claude/session-env/a/x.sh' /tmp/x`,
    `gawk --include=inplace '{print}' ~/.claude/session-env/a/x.sh`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  // uniq と xxd -r は 2 つ目の位置引数に書く（break-1 の指摘で足した）。- は標準入力を表す 1 つ目の位置引数で、
  // 2 つ目のファイルに書く（bash と zsh で session-env/a/x.sh ができるのを確かめた）。- を位置引数に数えず、出力を取りこぼす
  for (const command of ['echo x | uniq - ~/.claude/session-env/a/x.sh', 'xxd -r - ~/.claude/session-env/a/x.sh < /tmp/x.hex']) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // xxd の -seek、-cols は -s、-c の別の綴りで値を取り（man xxd）、GNU の uniq は長いオプションの省略（--skip-f）を受け付ける。
  // 値を位置引数に数えて、入力のファイルを出力とみなす（bash と zsh で、どれも session-env/a/x.sh を書くのを確かめた）
  for (const command of [
    'xxd -r -seek 0 /tmp/x.hex ~/.claude/session-env/a/x.sh',
    'xxd -r -cols 16 /tmp/x.hex ~/.claude/session-env/a/x.sh',
    'uniq --skip-f 1 /tmp/x ~/.claude/session-env/a/x.sh',
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // 同じ数え違いで、読むだけの形が止まる（止めすぎ）。docs の表は読むだけを通すとし、受け入れた止めすぎにも無い
  for (const command of [
    'xxd -len 16 ~/.claude/session-env/a/x.sh',
    'xxd -seek 4 ~/.claude/session-env/a/x.sh',
    'xxd -cols 8 ~/.claude/session-env/a/x.sh /tmp/o.hex',
    'uniq --skip-f 1 ~/.claude/session-env/a/x.sh',
  ]) {
    test(`[欠陥] 止めすぎ: ${command}`, () => expectAllow(command));
  }
  // patch -d は ask になる。--directory= は同じオプションの長い綴りで、差分の中の名前を指したディレクトリの下に書く。
  // cd の後の patch と git -C … apply（リポジトリの外では patch と同じく作業場所に書く）も同じ。どれも bash と zsh で
  // session-env/a/x.sh ができるのを確かめた。docs の表は cd と env -C の後の作業場所への書き込み（curl -O、tar x）を見るとしている
  for (const command of [
    'patch --directory=/root/.claude/session-env/x -p1 -i /tmp/p',
    'cd ~/.claude/session-env/x && patch -p1 < /tmp/p',
    'git -C ~/.claude/session-env/x apply /tmp/p',
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // checkout-index --prefix は、リポジトリの中のファイルを接頭辞の下に書き出す（一時のリポジトリから session-env/a/evil.sh が
  // できるのを確かめた）。中身はリポジトリにコミットした任意の本文で、git show --output= の形は ask になる
  test('[欠陥] git checkout-index --prefix=…/session-env/x/ evil.sh', () =>
    expectAsk('git checkout-index --prefix=/root/.claude/session-env/x/ evil.sh'));
  // sqlite3 の .output と .once は、続く結果を任意のファイルに書く（select 'export A=1' が session-env/a/x.sh に書かれるのを
  // 確かめた）。Issue のセッションが置いた前提は表に無い書き込みの道具を ask にする方針で、docs の「見えない形」に挙げた
  // 表に無い道具は「2 つ目の引数に書く道具」だけ
  for (const command of [
    `sqlite3 :memory: '.output /root/.claude/session-env/a/x.sh' "select 'export A=1';"`,
    `sqlite3 :memory: ".once /root/.claude/session-env/a/x.sh" "select 'export A=1';"`,
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // ruby -i は perl -i と同じくその場で書き換える（ruby 2.6 で書き換わるのを確かめた）。perl -pi.bak は ask になる
  for (const command of [`ruby -i -pe '$_.sub!(/a/,"export B=1")' ~/.claude/session-env/a/x.sh`, `ruby -pi -e 'x' ~/.claude/session-env/a/x.sh`]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // curl の --stderr と -w の %output{}（curl 8.3 以降）は、-w の任意の文字列をファイルに書く（curl 8.23 で
  // export A=1 が session-env/a/x.sh に書かれるのを確かめた）。curl -o と --output-dir は ask になる
  for (const command of [
    `curl -s --stderr ~/.claude/session-env/a/x.sh -w '%{stderr}export A=1' https://example.com`,
    `curl -s -w '%output{/root/.claude/session-env/a/x.sh}export A=1' https://example.com`,
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // awk のプログラムは判定の対象（docs の表）。-f /dev/stdin にヒアストリングで渡すプログラムは、source /dev/stdin の
  // ヒアストリング（break-1 の指摘で ask にした）と同じく字面で見える（bash と zsh で書き込みを確かめた）。
  // docs の限界「awk -f のスクリプトのファイル」は中身の見えないファイルの話で、この形は字面にある
  test(`[欠陥] awk -f /dev/stdin <<< 'BEGIN{print "x" > "…/session-env/a/x.sh"}'`, () =>
    expectAsk(`awk -f /dev/stdin <<< 'BEGIN{print "x" > "/root/.claude/session-env/a/x.sh"}'`));
});

describe('インタープリタの本文のフラグと前置き', () => {
  for (const command of [
    `python3 -Ic 'open("/root/.claude/session-env/a/x.sh","a")'`,
    `perl -wle 'open F,">>/root/.claude/session-env/a/x.sh"'`,
    `perl -Mstrict -e 'open F,">>/root/.claude/session-env/a/x.sh"'`,
    `ruby -rfileutils -e 'File.write("/root/.claude/session-env/a/x.sh","x")'`,
    `node -r fs -e 'require("fs").appendFileSync("/root/.claude/session-env/a/x.sh","x")'`,
    `node --eval='require("fs").appendFileSync("/root/.claude/session-env/a/x.sh","x")'`,
    `php -d x=1 -r 'file_put_contents("/root/.claude/session-env/a/x.sh","x");'`,
    `perl6 -e 'spurt "/root/.claude/session-env/a/x.sh", "x"'`,
    `npx tsx -e 'require("fs").appendFileSync("/root/.claude/session-env/a/x.sh","x")'`,
    `pnpm exec tsx -e 'require("fs").appendFileSync("/root/.claude/session-env/a/x.sh","x")'`,
    `pnpm dlx tsx -e 'require("fs").appendFileSync("/root/.claude/session-env/a/x.sh","x")'`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('git config -f の書く形と読む形', () => {
  for (const command of [
    'git config set --file /root/.claude/session-env/a/x.sh a.b c',
    'git config -f /root/.claude/session-env/a/x.sh --rename-section a b',
    'git config -f /root/.claude/session-env/a/x.sh --remove-section a',
    'git config -f /root/.claude/session-env/a/x.sh --add a.b c',
    'git config -f /root/.claude/session-env/a/x.sh --replace-all a.b c',
    'git --git-dir=/tmp/g config -f /root/.claude/session-env/a/x.sh a.b c',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'git config -f ~/.claude/session-env/a/x.sh -l',
    'git config -f ~/.claude/session-env/a/x.sh --get-regexp a',
    'git config -f ~/.claude/session-env/a/x.sh --get-all a.b',
    'git config get --file ~/.claude/session-env/a/x.sh a.b',
    'git config list --file ~/.claude/session-env/a/x.sh',
    'git config -f ~/.claude/session-env/a/x.sh -z --list',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});

describe('.claude とホームへの置き換えと展開', () => {
  for (const command of [
    'cd ~/.claude && ln -s /tmp/evil session-env',
    'cd ~/.claude && mv /tmp/evil session-env',
    'cd ~/.claude && cp -r /tmp/evil session-env',
    'cd ~ && tar xf /tmp/a.tar',
    'cd ~ && unzip /tmp/a.zip',
    'pushd ~ && tar xf /tmp/a.tar',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'cp -r ~/.claude/session-env /tmp/bk && echo x > /tmp/bk/a.sh',
    'tar xf /tmp/a.tar -C ~/work/proj',
    'rsync -a ~/work/proj/ ~/backup/',
    'cp -r /tmp/proj ~/work/',
    'cp -r /tmp/dotfiles/. ~/dotfiles/',
    String.raw`sed -E 's/(\w+)$/session-env\/\1/' /tmp/list`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
  // ホームへの再帰のコピーは、元の .claude/session-env/ をそのまま ~/.claude/session-env/ に置く（bash と zsh で、cp -r、cp -R、
  // rsync -a のどれも session-env/a/x.sh ができるのを確かめた）。docs の表は書庫の展開先がホームなら止め、break-1 の直しは
  // .claude への再帰のコピーを止めた。ホームへの再帰のコピーだけ通る
  for (const command of ['cp -r /tmp/h/. ~', 'cp -R /tmp/h/. ~/', 'cd ~ && cp -r /tmp/h/. .', 'rsync -a /tmp/h/ ~/']) {
    test(`[欠陥] ${command}`, () => expectAskAny(command));
  }
});

describe('リンクの後の ..（Bash）', () => {
  // tmp/deep -> tmp/home/.claude/session-env/0a1b/sub。open と cp は deep/.. をリンクの先の親（session-env/0a1b）として解く
  // （bash と zsh で echo x >> deep/../x.sh が session-env/0a1b/x.sh を作るのを確かめた）。照合は .. を字面で畳んでから
  // リンクを解くので tmp/x.sh になる。docs の表は「書き込み先の親のリンクを解いた絶対パスも見る」としている
  mkdirSync(path.join(tmp, 'home/.claude/session-env/0a1b/sub'), { recursive: true });
  symlinkSync(path.join(tmp, 'home/.claude/session-env/0a1b/sub'), path.join(tmp, 'deep'));
  for (const command of ['echo x >> deep/../x.sh', 'cp /tmp/x deep/../']) {
    test(`[欠陥] cwd=tmp: ${command}`, () => expectAsk(command, { cwd: tmp }));
  }
  test('[欠陥] リンクの後の .. を含む絶対パスへのリダイレクト', () => expectAsk(`echo x >> ${tmp}/deep/../x.sh`));
  // cd は既定で字面の上で .. を畳む（cd deep/.. は tmp に戻る）ので、その後の書き込みは通してよい
  test('[通す] cwd=tmp: cd deep/.. && echo x > x.sh', () => expectAllow('cd deep/.. && echo x > x.sh', { cwd: tmp }));
});
