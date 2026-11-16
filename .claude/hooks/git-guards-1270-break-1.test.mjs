// #1270: 環境のファイル（session-env、shell-snapshots、CLAUDE_ENV_FILE）への書き込みの判定を崩しにいくテスト。
// 保存済みのテスト（shell-env、session-env）と more に無い手口だけを置く。
// [欠陥] の付いたテストは、今の実装で落ちる形。横のコメントに、書き込みが実際に起きることと欠陥とみなす根拠を書く。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeBash } from './bash-rules.mjs';
import { SHELL_ENV_REASON } from './file-rules.mjs';

const verdict = (command, { cwd = '/repo', env = {} } = {}) => judgeBash(command, { cwd, branchOf: () => '1270-session-env', env });
const expectAsk = (command, options) => assert.deepEqual(verdict(command, options), ['ask', SHELL_ENV_REASON], command);
// 道具を判定できない前置きや守る仕組みの .claude の規則が先に当たる形は、理由が別でも ask であればよい
const expectAskAny = (command, options) => assert.equal(verdict(command, options)?.[0], 'ask', command);
const expectAllow = (command, options) => assert.equal(verdict(command, options), null, command);

const hooks = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(hooks, '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-1270-break-1-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// tmp/home/.claude/session-env/0a1b/x.sh と、そこへ向かう多段のリンク
const home = path.join(tmp, 'home');
const sessionDir = path.join(home, '.claude/session-env/0a1b');
mkdirSync(sessionDir, { recursive: true });
mkdirSync(path.join(home, '.claude/shell-snapshots'), { recursive: true });
mkdirSync(path.join(tmp, 'sub'));
writeFileSync(path.join(sessionDir, 'x.sh'), '');
symlinkSync(path.join(home, '.claude/session-env'), path.join(tmp, 'l1'));
symlinkSync(path.join(tmp, 'l1'), path.join(tmp, 'l2'));
symlinkSync(path.join(tmp, 'l2'), path.join(tmp, 'l3'));
symlinkSync(path.join(sessionDir, 'x.sh'), path.join(tmp, 'f1.sh'));
symlinkSync(path.join(tmp, 'f1.sh'), path.join(tmp, 'f2.sh'));
symlinkSync(path.join(sessionDir, 'new.sh'), path.join(tmp, 'dangling1.sh'));
symlinkSync(path.join(tmp, 'dangling1.sh'), path.join(tmp, 'dangling2.sh'));
symlinkSync('home/.claude/session-env/0a1b/rel.sh', path.join(tmp, 'relative-link.sh'));
symlinkSync(home, path.join(tmp, 'h'));
// 名前に session-env を含まない起動元の CLAUDE_ENV_FILE と、それを指すリンク
const envFile = path.join(tmp, 'claude-env.sh');
writeFileSync(envFile, '');
symlinkSync(envFile, path.join(tmp, 'env-link.sh'));
const withEnvFile = { env: { CLAUDE_ENV_FILE: envFile } };

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !['CLAUDE_ENV_FILE', 'CLAUDE_CODE_REMOTE'].includes(key)),
);
const runGuardFiles = (toolName, filePath, { cwd = tmp, env = {} } = {}) => {
  const toolInput =
    toolName === 'Write'
      ? { file_path: filePath, content: 'export GH_REPO=other/repo' }
      : toolName === 'MultiEdit'
        ? { file_path: filePath, edits: [{ old_string: 'a', new_string: 'b' }] }
        : { file_path: filePath, old_string: 'a', new_string: 'b' };
  const result = spawnSync(process.execPath, [path.join(hooks, 'guard-files.mjs')], {
    input: JSON.stringify({ tool_name: toolName, cwd, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...cleanEnv, HOME: home, CLAUDE_PROJECT_DIR: '', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
};

describe('引用符、エスケープ、パスの綴り', () => {
  for (const command of [
    'echo x >> ~/.claude/"session-env"/a/x.sh',
    "echo x >> ~/.claude/sess''ion-env/a/x.sh",
    String.raw`echo x >> ~/.claude/sess\ion-env/a/x.sh`,
    String.raw`echo x >> $'/root/.claude/sess\x69on-env/a/x.sh'`,
    String.raw`echo x >> $'/root/.claude/sess\151on-env/a/x.sh'`,
    'echo x >> "/root/.claude/sess"ion-env/a/x.sh',
    'echo x >> /root//.claude//session-env//a/x.sh',
    'echo x >> /root/.claude/x/../session-env/a/x.sh',
    'echo x >> ~/.Claude/Shell-Snapshots/s.sh',
    'echo x >> ~/.claude/{session,x}-env/a.sh',
    'tee -a ~/.claude/sess{ion-env,x}/a.sh',
    'echo x >> ~/.claude/session-en[v]/a.sh',
    'echo x >> ~root/.claude/session-env/a.sh',
    'echo x >> ${HOME}/.claude/session-env/a.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('リダイレクトの別の書き方', () => {
  for (const command of [
    'echo x >| ~/.claude/session-env/a/x.sh',
    'echo x >! ~/.claude/session-env/a/x.sh',
    'echo x >>| ~/.claude/session-env/a/x.sh',
    'echo x &>> ~/.claude/session-env/a/x.sh',
    'echo x 9>~/.claude/session-env/a/x.sh',
    'echo x > /tmp/a 2> ~/.claude/session-env/a/x.sh',
    'exec 3<> ~/.claude/session-env/a/x.sh',
    'exec >> ~/.claude/session-env/a/x.sh',
    'exec {fd}>>~/.claude/session-env/a.sh',
    '{ echo x; } >> ~/.claude/session-env/a/x.sh',
    'for i in 1; do echo x; done >> ~/.claude/session-env/a/x.sh',
    '>> ~/.claude/session-env/a/x.sh echo x',
    'echo x >> ~/.claude/session-env/a.sh &',
    'echo x > >(tee -a ~/.claude/session-env/a/x.sh)',
    'cat <<< x >> ~/.claude/session-env/a/x.sh',
    'x=$(tee -a ~/.claude/session-env/a.sh < /tmp/x)',
    'x=`tee -a ~/.claude/session-env/a.sh < /tmp/x`',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
});

describe('書き込みの道具のオプションの別の書き方', () => {
  for (const command of [
    'echo x | tee -i -p --append ~/.claude/session-env/a/x.sh',
    'echo x | tee -- ~/.claude/session-env/a/x.sh',
    'echo x | tee /dev/null ~/.claude/session-env/a/x.sh',
    'install -D /tmp/x ~/.claude/session-env/a/x.sh',
    'install -t ~/.claude/session-env/a /tmp/x',
    'cp --target-directory=/root/.claude/session-env/a /tmp/x',
    'cp --targ /root/.claude/session-env/a /tmp/x',
    'cp -t/root/.claude/session-env/a /tmp/x',
    'mv -t /root/.claude/session-env/a /tmp/x',
    'mv --target-directory /root/.claude/session-env/a /tmp/x',
    'mv /tmp/x.sh ~/.claude/shell-snapshots',
    'ln -st /root/.claude/session-env/a /tmp/x',
    'cp -- /tmp/x /root/.claude/session-env/a/x.sh',
    'rsync -e ssh /tmp/x /root/.claude/session-env/a/',
    'dd of="$CLAUDE_ENV_FILE" oflag=append conv=notrunc',
    'curl -so ~/.claude/session-env/a/x.sh https://example.com/x',
    'curl -o~/.claude/session-env/a/x.sh https://example.com/x',
    'curl --output-dir ~/.claude/session-env/a -O https://example.com/x.sh',
    'wget -O ~/.claude/session-env/a/x.sh https://example.com/x',
    'wget -P ~/.claude/session-env/a https://example.com/x.sh',
    'wget --output-document=~/.claude/session-env/a/x.sh https://example.com/x',
    'truncate -s 0 ~/.claude/session-env/a/x.sh',
    'touch ~/.claude/session-env/a/x.sh',
    'patch ~/.claude/session-env/a/x.sh /tmp/p',
    'patch -o ~/.claude/session-env/a/x.sh /tmp/a /tmp/p',
    "perl -pi -e 's/a/b/' ~/.claude/session-env/a/x.sh",
    `perl -e 'open F,">>",$ENV{CLAUDE_ENV_FILE}; print F "x"'`,
    "ex -sc '$a|x' -cx ~/.claude/session-env/a/x.sh",
    "vim -es -c 'normal Ax' -c wq ~/.claude/session-env/a/x.sh",
    String.raw`ed -s ~/.claude/session-env/a/x.sh <<< $'a\nx\n.\nw'`,
    "sed --in-place 's/a/b/' ~/.claude/session-env/a/x.sh",
    "sed -Ei 's/a/b/' ~/.claude/session-env/a/x.sh",
    "sed -e '$a export GH_REPO=o/r' -i ~/.claude/session-env/a/x.sh",
    'ditto /tmp/x ~/.claude/session-env/a/x.sh',
    'find /tmp -name x -fprint ~/.claude/session-env/a/x.sh',
    String.raw`find /tmp -fprintf ~/.claude/session-env/a/x.sh 'export GH_REPO=o/r\n'`,
    String.raw`find /tmp/x -exec cp {} ~/.claude/session-env/a/ \;`,
    "find ~/.claude/session-env -name '*.sh' -exec sed -i 's/a/b/' {} +",
    'xargs -a /tmp/x tee -a ~/.claude/session-env/a/x.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of ['echo /tmp/x | xargs -I{} cp {} ~/.claude/session-env/a/', 'echo ~/.claude/session-env/a/x.sh | xargs tee -a']) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
});

describe('前置きと入れ子のシェル', () => {
  for (const command of [
    "zsh -c 'echo x >> ~/.claude/session-env/a/x.sh'",
    "bash -lc 'echo x >> ~/.claude/session-env/a/x.sh'",
    "bash -o errexit -c 'echo x >> ~/.claude/session-env/a/x.sh'",
    "/bin/sh -c 'echo x >> ~/.claude/session-env/a/x.sh'",
    "nohup sh -c 'echo x >> ~/.claude/session-env/a.sh'",
    "sudo -E sh -c 'echo x >> ~/.claude/session-env/a.sh'",
    'command tee -a ~/.claude/session-env/a/x.sh',
    'builtin echo x >> ~/.claude/session-env/a/x.sh',
    'timeout -s KILL 5 cp /tmp/x ~/.claude/session-env/a/x.sh',
    'env -i tee -a ~/.claude/session-env/a/x.sh',
    'env -u X tee -a ~/.claude/session-env/a.sh',
    'sudo -u root cp /tmp/x ~/.claude/session-env/a/',
    'nice -n 5 cp /tmp/x ~/.claude/session-env/a/',
    'time cp /tmp/x ~/.claude/session-env/a/',
    'exec cp /tmp/x ~/.claude/session-env/a/',
    'pnpm exec tee -a ~/.claude/session-env/a/x.sh',
    'watch -n1 cp /tmp/x ~/.claude/session-env/a/',
    'stdbuf -o0 tee -a ~/.claude/session-env/a/x.sh',
    'FOO=1 tee -a ~/.claude/session-env/a/x.sh',
    String.raw`\cp /tmp/x ~/.claude/session-env/a/`,
    '"cp" /tmp/x ~/.claude/session-env/a/',
    '/bin/cp /tmp/x ~/.claude/session-env/a/',
    'gcp /tmp/x ~/.claude/session-env/a/',
    'f() { tee -a ~/.claude/session-env/a/x.sh; }; f',
    `echo 'echo x >> ~/.claude/session-env/a/x.sh' | source /dev/stdin`,
    `echo 'echo x >> ~/.claude/session-env/a/x.sh' | . /dev/fd/0`,
    `echo 'echo x >> "$CLAUDE_ENV_FILE"' | bash -s`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    "env -S 'tee -a /root/.claude/session-env/a/x.sh' < /tmp/x",
    `uv run python -c 'open("/root/.claude/session-env/a/x.sh","a")'`,
    `python3 <(echo 'open("/root/.claude/session-env/a/x.sh","a")')`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
  // bash と zsh で、here-string と heredoc を /dev/stdin から読み込んだ本文が実行され、書き込みが起きる
  // （一時の HOME で確かめた）。同じ本文をパイプで `| source /dev/stdin` に渡す形は ask なので、入力の渡し方だけで
  // 判定が変わる。docs/development.md の「見えない形」にも無い。
  for (const command of [
    `. /dev/stdin <<< 'echo x >> ~/.claude/session-env/a/x.sh'`,
    `source /dev/stdin <<'E'\necho x >> ~/.claude/session-env/a/x.sh\nE`,
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // coproc は後ろの道具をそのまま動かす（bash と zsh で tee -a が書き込むのを確かめた）。tee は表にある道具で、
  // 前置きの command、nohup、time は ask になる
  test('[欠陥] coproc tee -a ~/.claude/session-env/a/x.sh', () => expectAsk('coproc tee -a ~/.claude/session-env/a/x.sh'));
});

describe('インタープリタの本文', () => {
  for (const command of [
    `python3 -c "import os;open(os.path.expanduser('~/.claude/session-env/a/x.sh'),'a').write('x')"`,
    `python -c 'open("/root/.claude/session-env/a/x.sh","a")'`,
    `bun --eval 'Bun.write("/root/.claude/session-env/a/x.sh","x")'`,
    `node -pe 'require("fs").appendFileSync("/root/.claude/session-env/a/x.sh","x")'`,
    `node --input-type=module -e 'import fs from "fs"; fs.appendFileSync(process.env.CLAUDE_ENV_FILE,"x")'`,
    `node <<< 'require("fs").appendFileSync(process.env.CLAUDE_ENV_FILE,"x")'`,
    `php -r 'file_put_contents(getenv("CLAUDE_ENV_FILE"),"x",FILE_APPEND);'`,
    `osascript -e 'do shell script "echo x >> ~/.claude/session-env/a/x.sh"'`,
    `awk 'BEGIN{print "x" | "cat >> ~/.claude/session-env/a/x.sh"}'`,
    `awk 'BEGIN{system("echo x >> ~/.claude/session-env/a/x.sh")}'`,
    `nawk 'BEGIN{print "x" >> "/root/.claude/session-env/a/x.sh"}'`,
    `busybox awk 'BEGIN{print "x" >> "/root/.claude/session-env/a/x.sh"}'`,
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  // awk の本文は判定の対象（docs の表）。書き込み先は -v で渡したパスの字面で、シェルの変数を経由した形
  // （受け入れた限界）ではない。printf … | awk -v f=… '{print > f}' で書き込みが起きるのを確かめた
  test(`[欠陥] awk -v f=… 'BEGIN{print "x" > f}'`, () => expectAsk(`awk -v f=/root/.claude/session-env/a/x.sh 'BEGIN{print "x" > f}'`));
  // Issue のセッションが置いた前提「表に無い…インタープリタの名前は、環境のファイルへの書き込みで ask にする」と、
  // docs の「CLAUDE_ENV_FILE の名前だけでも当てる」。lua はこの端末に入っており、python3、ruby3、php は当たる
  for (const command of [
    `lua -e 'io.open(os.getenv("CLAUDE_ENV_FILE"),"a"):write("x")'`,
    `pypy3 -c 'open("/root/.claude/session-env/a/x.sh","a")'`,
    `deno eval 'Deno.writeTextFileSync("/root/.claude/session-env/a/x.sh","x")'`,
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
});

describe('表に無い書き込みの道具', () => {
  // どれも 2 つ目の引数のファイルに書く（一時の HOME で、uniq と xxd -r が export の行を書くのを確かめた）。
  // Issue の前提は表に無い書き込みの道具を ask にする方針で、docs の「見えない形」にも無い
  for (const command of ['uniq /tmp/x ~/.claude/session-env/a/x.sh', 'xxd -r /tmp/x.hex ~/.claude/session-env/a/x.sh']) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
  // git config -f は任意のファイルに書く。節の名前の '$(…)' がそのまま [a "$(…)"] の行になり、Bash の前に
  // 読み込まれると置換が走る（bash で読み込んで INJECTED が出るのを確かめた）
  for (const command of [
    `git config -f ~/.claude/session-env/a/x.sh 'a.$(echo x).b' v`,
    'git config --file ~/.claude/session-env/a/x.sh x.y z',
  ]) {
    test(`[欠陥] ${command}`, () => expectAsk(command));
  }
});

describe('書庫の展開の別のフラグ順', () => {
  for (const command of [
    'tar -xvzf /tmp/a.tgz -C /root/.claude/session-env',
    'unzip -d ~/.claude /tmp/a.zip',
    'unzip -od ~/.claude /tmp/a.zip',
    'unzip /tmp/a.zip -d~/.claude',
    '7z x -o/root/.claude /tmp/a.7z',
    '7za x /tmp/a.7z -o/root/.claude',
    'gunzip -c /tmp/x.gz > ~/.claude/session-env/a/x.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  for (const command of [
    'tar --directory ~/.claude -xf /tmp/a.tar',
    'tar --extract --file=/tmp/a.tar -C ~/.claude',
    'gtar xf /tmp/a.tar -C ~/.claude',
    'ditto -x -k /tmp/a.zip ~/.claude',
    'mv /tmp/session-env ~/.claude/',
    'rsync -a /tmp/home-claude/ ~/.claude/',
    'cp -R /tmp/x/. ~/.claude/',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAskAny(command));
  }
});

describe('cd の別の書き方と、作業場所への暗黙の書き込み', () => {
  for (const command of [
    'pushd ~/.claude/session-env/x > /dev/null; echo x >> a.sh',
    'pushd ~/.claude/session-env/x; pushd /tmp; pushd +1; echo x >> a.sh',
    'cd -P ~/.claude/session-env/x && echo x >> a.sh',
    'cd -- ~/.claude/session-env/x && echo x >> a.sh',
    'cd ~/.claude/session-env/x || exit; echo x >> a.sh',
    'cd ~/.claude/session-env/x\necho x >> a.sh',
    'CDPATH=~/.claude cd session-env && echo x >> a.sh',
    'cd ~/.claude; cd session-env; cd x; echo x >> a.sh',
    'cd ~/.claude && cd ./session-env/../shell-snapshots && echo x >> a.sh',
    'cd && echo x >> .claude/session-env/a/x.sh',
    'cd $HOME && echo x >> .claude/session-env/a/x.sh',
    '(cd ~/.claude/session-env/x && echo x >> a.sh)',
    'cd ~/.claude/session-env/x && echo x > "$(pwd)/a.sh"',
    'cd ~/.claude/session-env/x && cp /tmp/x.sh .',
    'cd ~/.claude/session-env/x && mv /tmp/x.sh .',
    'cd ~/.claude/session-env/x && ln -s /tmp/x.sh .',
    'cd ~/.claude/session-env/x && cp -t . /tmp/x.sh',
    'cd ~/.claude/session-env/x && curl -sSLO https://example.com/a.sh',
    'cd ~/.claude/session-env/x && curl --remote-name https://example.com/a.sh',
    'cd ~/.claude/session-env/x && wget https://example.com/a.sh',
    `cd ~/.claude/session-env/x && python3 -c 'open("a.sh","a").write("x")'`,
    `cd ~/.claude/session-env/x && awk 'BEGIN{print "x" > "a.sh"}'`,
    'cd ~/.claude/session-env/x && dd of=a.sh',
  ]) {
    test(`[すり抜け] ${command}`, () => expectAsk(command));
  }
  // 引数 1 つの ln -s は作業場所に元と同じ名前のリンクを作る（session-env/x/x.sh ができるのを確かめた）。
  // docs の表は「cd … の後の相対パス」と ln を見るとし、宛先に . を書いた形は ask になる
  test('[欠陥] cd ~/.claude/session-env/x && ln -s /tmp/x.sh', () => expectAsk('cd ~/.claude/session-env/x && ln -s /tmp/x.sh'));
  // ~/.claude に移ってから中身を . へ写すと session-env/ の下が書かれる（cp -r src/. . で session-env/y/z.sh ができるのを
  // 確かめた）。cd を使わない同じ形 cp -R /tmp/x/. ~/.claude/ は ask になる
  test('[欠陥] cd ~/.claude && cp -r /tmp/se/. .', () => expectAskAny('cd ~/.claude && cp -r /tmp/se/. .'));
});

describe('多段のリンクと相対のリンク（Bash）', () => {
  for (const command of [
    'echo x >> ./l3/0a1b/a.sh',
    'cp /tmp/x l2/0a1b/',
    'echo x >> f2.sh',
    'echo x >> dangling2.sh',
    'tee -a relative-link.sh',
    'echo x >> h/.claude/shell-snapshots/a.sh',
    'cd l3 && echo x >> 0a1b/a.sh',
  ]) {
    test(`[すり抜け] cwd=tmp: ${command}`, () => expectAsk(command, { cwd: tmp }));
  }
  for (const command of ['cat l3/0a1b/x.sh > /tmp/o', 'cat f2.sh']) {
    test(`[通す] cwd=tmp: ${command}`, () => expectAllow(command, { cwd: tmp }));
  }
});

describe('起動元の CLAUDE_ENV_FILE の値の綴り（Bash）', () => {
  for (const command of [
    `echo x >> ${tmp}/./claude-env.sh`,
    `echo x >> ${tmp}//claude-env.sh`,
    `echo x >> ${tmp}/sub/../claude-env.sh`,
    `echo x >> ${tmp}/Claude-Env.sh`,
    `echo x >> ${tmp}/claude-env.{sh,x}`,
    `cd ${tmp}/sub && echo x >> ../claude-env.sh`,
    `ln -sf /tmp/x ${tmp}/claude-env.sh`,
  ]) {
    test(`[すり抜け] ${command.replaceAll(tmp, '$T')}`, () => expectAsk(command, withEnvFile));
  }
  test('[通す] CLAUDE_ENV_FILE を写す元にする', () => expectAllow(`cp ${tmp}/claude-env.sh /tmp/`, withEnvFile));
  // Issue のセッションが置いた前提「起動元の CLAUDE_ENV_FILE の値があれば、その絶対パスにも当てる」。宛先がディレクトリの
  // cp と mv は、そのディレクトリの下の claude-env.sh を書く。session-env の名前のディレクトリへの cp は ask になる
  for (const command of [`cp /tmp/claude-env.sh ${tmp}/`, `mv /tmp/claude-env.sh ${tmp}`]) {
    test(`[欠陥] ${command.replaceAll(tmp, '$T')}`, () => expectAsk(command, withEnvFile));
  }
  // CLAUDE_ENV_FILE を指すリンクへの書き込みは、リンクの先の CLAUDE_ENV_FILE を書く。session-env のファイルを指す
  // リンク（f2.sh）なら ask になり、docs の表は書き込み先のリンクを解いて見るとしている
  test('[欠陥] CLAUDE_ENV_FILE を指すリンクへのリダイレクト', () => expectAsk(`echo x >> ${tmp}/env-link.sh`, withEnvFile));
});

describe('Write と Edit のパスの綴り', () => {
  for (const [toolName, filePath] of [
    ['Write', 'home/.claude/x/../session-env/0a1b/a.sh'],
    ['Write', './home/.claude/session-env/0a1b/a.sh'],
    ['Write', 'sub/../home/.claude/session-env/0a1b/a.sh'],
    ['Write', '~/.claude/./session-env/a.sh'],
    ['Write', '~/.claude/x/../shell-snapshots/a.sh'],
    ['Write', '~/.CLAUDE/SHELL-SNAPSHOTS/a.sh'],
    ['Write', path.join(tmp, 'l3/0a1b/a.sh')],
    ['Write', path.join(tmp, 'f1.sh')],
    ['Edit', path.join(tmp, 'f2.sh')],
    ['MultiEdit', path.join(tmp, 'dangling2.sh')],
    ['Write', path.join(tmp, 'relative-link.sh')],
    ['Write', 'h/.claude/session-env/0a1b/a.sh'],
    ['Write', path.join(tmp, 'h/.claude/shell-snapshots/new/a.sh')],
  ]) {
    test(`[すり抜け] ${toolName} ${filePath.replace(tmp, '$T')}`, () => assert.equal(runGuardFiles(toolName, filePath), 'ask'));
  }
  for (const filePath of [path.join(tmp, './claude-env.sh'), 'claude-env.sh', path.join(tmp, 'sub/../claude-env.sh'), path.join(tmp, 'Claude-Env.sh')]) {
    test(`[すり抜け] Write ${filePath.replace(tmp, '$T')}（起動元の CLAUDE_ENV_FILE）`, () =>
      assert.equal(runGuardFiles('Write', filePath, { env: { CLAUDE_ENV_FILE: envFile } }), 'ask'));
  }
  for (const filePath of [path.join(tmp, 'note.sh'), path.join(tmp, 'session-env-notes.md'), path.join(tmp, 'h/notes.md')]) {
    test(`[通す] Write ${filePath.replace(tmp, '$T')}`, () => assert.equal(runGuardFiles('Write', filePath), 'allow'));
  }
  // Write はリンクを辿って先のファイルを書く。docs の Write と Edit の行は「親のリンクを解いたパス、まだ無いファイルを
  // 指すリンクの先で見る」とし、session-env のファイルを指すリンク（f1.sh）は ask になる。CLAUDE_ENV_FILE を指す
  // リンクだけ照合から漏れる
  test('[欠陥] Write CLAUDE_ENV_FILE を指すリンク', () =>
    assert.equal(runGuardFiles('Write', path.join(tmp, 'env-link.sh'), { env: { CLAUDE_ENV_FILE: envFile } }), 'ask'));
});

describe('deny は別の綴りでも下がらない', () => {
  for (const [toolName, filePath] of [
    ['Write', 'src/routes/shell-snapshots/+page.server.ts'],
    ['Write', path.join(worktree, 'src/routes/session-env/x/../+page.server.ts')],
    ['Write', path.join(worktree, 'src/routes/(app)/session-env/+layout.server.ts')],
    ['Edit', path.join(worktree, 'src/routes/SESSION-ENV/+server.ts')],
    ['MultiEdit', path.join(worktree, 'src/routes/session-env/+page.server.ts')],
  ]) {
    test(`[完了条件] ${toolName} ${filePath.replace(worktree, '$W')} は deny`, () =>
      assert.equal(runGuardFiles(toolName, filePath, { cwd: worktree, env: { CLAUDE_PROJECT_DIR: worktree } }), 'deny'));
  }
});

describe('止めすぎ（読むだけ）', () => {
  for (const command of [
    'cat ~/.claude/session-env/a/x.sh > /tmp/out',
    'diff ~/.claude/session-env/a/x.sh /tmp/x',
    'wc -l ~/.claude/shell-snapshots/*.sh',
    'tail -f ~/.claude/session-env/a/x.sh',
    'sort ~/.claude/session-env/a/x.sh -o /tmp/o',
    'tar -cf /tmp/a.tar ~/.claude/session-env',
    'tar czf /tmp/a.tgz -C ~/.claude session-env',
    'mv ~/.claude/session-env/a/x.sh /tmp/x',
    'cat ~/.claude/session-env/a/x.sh | tee /tmp/o',
    'grep -l PATH ~/.claude/shell-snapshots/* | xargs cat',
    'printenv CLAUDE_ENV_FILE',
    'test -f "$CLAUDE_ENV_FILE" && echo yes',
    'cp ~/.claude/session-env/a/x.sh .',
    'rsync -a ~/.claude/session-env /tmp/',
    `awk '{print > "/tmp/o"}' ~/.claude/session-env/a.sh`,
    `cat ~/.claude/session-env/a.sh | node -e 'process.stdin.pipe(process.stdout)'`,
    "find ~/.claude/session-env -name '*.sh' -exec cat {} +",
    'find ~/.claude/session-env -fprint /tmp/o',
    'tee /tmp/o < ~/.claude/session-env/a.sh',
    'dd if=/root/.claude/session-env/a of=/tmp/o',
    'cp ~/.claude/session-env/a/x.sh /tmp/session-env-copy.sh',
    'cd ~/.claude/session-env/x && cp a.sh /tmp/b.sh',
    'cd ~/.claude/session-env/x && tar cf /tmp/a.tar .',
    'cd ~/.claude/session-env/x && grep -r PATH . > /tmp/o',
    'cd ~/.claude/session-env/x; cd /tmp; echo x > a.sh',
    'pushd ~/.claude/session-env && ls && popd',
    'cd ~/.claude/session-env/x && rsync -a . /tmp/bk/',
    'cd ~/.claude/session-env/x && zip -r /tmp/a.zip .',
    'echo x > /tmp/session-env.log',
    'echo x > /tmp/shell-snapshots-backup.tar',
    'git diff > /tmp/session-env.patch',
    'echo ~/.claude/session-env/a.sh > /tmp/path.txt',
    'node scripts/x.mjs --out /tmp/o ~/.claude/session-env',
  ]) {
    test(`[通す] ${command}`, () => expectAllow(command));
  }
});
