import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
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

function commandOf(event: string): string {
  const entries = settings.hooks[event] ?? [];
  const commands = entries.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.equal(commands.length, 1, `${event} のフックがちょうど1つでない`);
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
  return { status: result.status, stdout: result.stdout };
}

describe('japanese-guard の登録', () => {
  test('PreToolUse は wrap_up の MCP ツールだけに掛け、Stop と同じスクリプトを呼ぶ', () => {
    const [entry] = settings.hooks.PreToolUse!.filter((e) => e.hooks.some((h) => h.command.includes('japanese-guard')));
    assert.equal(entry?.matcher, 'mcp__.*__wrap_up');
    assert.equal(commandOf('PreToolUse'), commandOf('Stop'));
  });

  test('英語の最終回答は差し戻し、日本語の最終回答は何も出さない', () => {
    const english = run(commandOf('Stop'), repoRoot, STOP_INPUT);
    assert.equal(english.status, 0);
    assert.equal(JSON.parse(english.stdout).decision, 'block');
    const japanese = run(commandOf('Stop'), repoRoot, JAPANESE_STOP_INPUT);
    assert.equal(japanese.status, 0);
    assert.equal(japanese.stdout, '');
  });

  test('JAPANESE_GUARD_DISABLE=1 のときは、英語でも何も出さない（ai-review の設定の意味）', () => {
    const disabled = { JAPANESE_GUARD_DISABLE: '1' };
    assert.deepEqual(run(commandOf('Stop'), repoRoot, STOP_INPUT, disabled), { status: 0, stdout: '' });
    assert.deepEqual(run(commandOf('PreToolUse'), repoRoot, WRAP_UP_INPUT, disabled), { status: 0, stdout: '' });
  });

  test('英語の wrap_up は PreToolUse で deny する', () => {
    const result = run(commandOf('PreToolUse'), repoRoot, WRAP_UP_INPUT);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('japanese-guard はセッションを止めない', () => {
  for (const event of ['Stop', 'PreToolUse']) {
    test(`${event}: スクリプトが無いときは、何も出さずに終了コード 0 で終わる`, () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'japanese-guard-'));
      const result = run(commandOf(event), emptyDir, STOP_INPUT);
      assert.deepEqual(result, { status: 0, stdout: '' });
    });

    test(`${event}: CLAUDE_PROJECT_DIR が空でも、終了コード 0 で終わる`, () => {
      const result = run(commandOf(event), '', STOP_INPUT);
      assert.deepEqual(result, { status: 0, stdout: '' });
    });

    // -I が無いと、python3 はスクリプトのあるディレクトリを import の探索に入れ、隣に置かれた json.py などを先に読む
    test(`${event}: -I で起動し、スクリプトの隣の同名モジュールを読まない`, () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'japanese-guard-'));
      const hooksDir = join(projectDir, '.claude', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'japanese-guard.py'), "import json\nprint('ran')\n");
      writeFileSync(join(hooksDir, 'json.py'), 'raise SystemExit(7)\n');
      const result = run(commandOf(event), projectDir, STOP_INPUT);
      assert.deepEqual(result, { status: 0, stdout: 'ran\n' });
    });

    // 'ran' を出させて、スクリプトが実際に走ったことを確かめる（引用符を外すと、空白入りのパスでは [ -f ] が偽になり、何も走らずに 0 で終わる）
    test(`${event}: パスに空白があっても走り、スクリプトが 0 以外で終わっても、終了コード 0 で終わる`, () => {
      const projectDir = join(mkdtempSync(join(tmpdir(), 'japanese-guard-')), 'a b');
      mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
      writeFileSync(join(projectDir, '.claude', 'hooks', 'japanese-guard.py'), "import sys\nprint('ran')\nsys.exit(3)\n");
      const result = run(commandOf(event), projectDir, STOP_INPUT);
      assert.deepEqual(result, { status: 0, stdout: 'ran\n' });
    });
  }
});
