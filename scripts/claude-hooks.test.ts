import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// .claude/settings.json の japanese-guard のフックの command を、sh -c で実際に走らせて確かめる（docs/development.md の「Claude の設定」）。
// python3 はスクリプトが無いと終了コード 2 を返し、Stop のフックでは終了を止める扱いになるので、必ず 0 で終えることを固定する。
// 落ちるのは、command を python3 の直書きに戻す、exit 0 を消す、-I を消す、引用符を外す、のとき。
// [ -f ] だけを消しても、exit 0 が終了コード 2 を潰すので落ちない（スクリプトが無いときに python3 を起動しないための前置き）
type Hook = { matcher?: string; hooks: { type: string; command: string }[] };

const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8')) as {
  hooks: Record<string, Hook[]>;
};
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const ENGLISH = 'I have finished updating the configuration file and everything should work now.';
const STOP_INPUT = JSON.stringify({ last_assistant_message: ENGLISH });
const JAPANESE_STOP_INPUT = JSON.stringify({ last_assistant_message: '設定を更新しました。' });
const WRAP_UP_INPUT = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'mcp__x__wrap_up',
  tool_input: { recap: ENGLISH, ask: 'Shall I open the pull request now' },
});

// japanese-guard の command だけを取る（ほかのフックが同じイベントに増えても落とさない）
function commandOf(event: string): string {
  const entries = settings.hooks[event] ?? [];
  const commands = entries
    .flatMap((entry) => entry.hooks.map((hook) => hook.command))
    .filter((command) => command.includes('japanese-guard'));
  assert.equal(commands.length, 1, `${event} の japanese-guard のフックがちょうど1つでない`);
  return commands[0]!;
}

// 親に JAPANESE_GUARD_*（ai-review の JAPANESE_GUARD_DISABLE や、人が付けたしきい値）があると、スクリプトが何も出さずにテストが退行と関係なく落ちる。
// 親の値は引き継がず、必要なものだけを extraEnv で渡す
function run(command: string, projectDir: string, input: string, extraEnv: Record<string, string> = {}) {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('JAPANESE_GUARD_'));
  const result = spawnSync('sh', ['-c', command], {
    input,
    encoding: 'utf8',
    env: { ...Object.fromEntries(inherited), CLAUDE_PROJECT_DIR: projectDir, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// 失敗したときに原因を切り分けられるよう、stderr をメッセージに付ける
function assertResult(result: ReturnType<typeof run>, stdout: string) {
  const detail = `status=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
  assert.equal(result.status, 0, detail);
  assert.equal(result.stdout, stdout, detail);
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'japanese-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('japanese-guard の登録', () => {
  // python3 が無いと、以降の多くのテストは何も出さずに緑になるか、JSON.parse('') で落ちる。先にここで明示して落とす
  test('python3 が使える', () => {
    const result = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'python3 が無い。このテストは python3 の入った環境で走らせる');
  });

  test('PreToolUse は wrap_up の MCP ツールだけに掛け、Stop と同じスクリプトを呼ぶ', () => {
    const [entry] = settings.hooks.PreToolUse!.filter((e) => e.hooks.some((h) => h.command.includes('japanese-guard')));
    assert.equal(entry?.matcher, 'mcp__.*__wrap_up');
    assert.equal(commandOf('PreToolUse'), commandOf('Stop'));
  });

  test('英語の最終回答は差し戻し、日本語の最終回答は何も出さない', () => {
    const english = run(commandOf('Stop'), repoRoot, STOP_INPUT);
    assert.equal(english.status, 0, english.stderr);
    assert.equal(JSON.parse(english.stdout).decision, 'block');
    assertResult(run(commandOf('Stop'), repoRoot, JAPANESE_STOP_INPUT), '');
  });

  test('JAPANESE_GUARD_DISABLE=1 のときは、英語でも何も出さない（ai-review の設定の意味）', () => {
    const disabled = { JAPANESE_GUARD_DISABLE: '1' };
    assertResult(run(commandOf('Stop'), repoRoot, STOP_INPUT, disabled), '');
    assertResult(run(commandOf('PreToolUse'), repoRoot, WRAP_UP_INPUT, disabled), '');
  });

  test('英語の wrap_up は PreToolUse で deny する', () => {
    const result = run(commandOf('PreToolUse'), repoRoot, WRAP_UP_INPUT);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('japanese-guard はセッションを止めない', () => {
  for (const event of ['Stop', 'PreToolUse']) {
    test(`${event}: スクリプトが無いときは、何も出さずに終了コード 0 で終わる`, (t) => {
      assertResult(run(commandOf(event), tempDir(t), STOP_INPUT), '');
    });

    test(`${event}: CLAUDE_PROJECT_DIR が空でも、終了コード 0 で終わる`, () => {
      assertResult(run(commandOf(event), '', STOP_INPUT), '');
    });

    // -I が無いと、python3 はスクリプトのあるディレクトリを import の探索に入れ、隣に置かれた json.py などを先に読む
    test(`${event}: -I で起動し、スクリプトの隣の同名モジュールを読まない`, (t) => {
      const projectDir = tempDir(t);
      const hooksDir = join(projectDir, '.claude', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'japanese-guard.py'), "import json\nprint('ran')\n");
      writeFileSync(join(hooksDir, 'json.py'), 'raise SystemExit(7)\n');
      assertResult(run(commandOf(event), projectDir, STOP_INPUT), 'ran\n');
    });

    // 'ran' を出させて、スクリプトが実際に走ったことを確かめる（引用符を外すと、空白入りのパスでは [ -f ] が偽になり、何も走らずに 0 で終わる）
    test(`${event}: パスに空白があっても走り、スクリプトが 0 以外で終わっても、終了コード 0 で終わる`, (t) => {
      const projectDir = join(tempDir(t), 'a b');
      mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
      writeFileSync(
        join(projectDir, '.claude', 'hooks', 'japanese-guard.py'),
        "import sys\nprint('ran')\nsys.exit(3)\n",
      );
      assertResult(run(commandOf(event), projectDir, STOP_INPUT), 'ran\n');
    });
  }
});
