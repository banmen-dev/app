import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// .claude/settings.json の japanese-guard のフックの command を、sh -c で実際に走らせて確かめる（docs/development.md の「Claude の設定」）。
// command を python3 の直書きに戻す、[ -f ] や exit 0 や -I を消す、のどれをしてもここが落ちる。
// python3 はスクリプトが無いと終了コード 2 を返し、Stop のフックでは終了を止める扱いになるので、必ず 0 で終えることを固定する
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

function run(command: string, projectDir: string, input: string) {
  const result = spawnSync('sh', ['-c', command], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
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

    test(`${event}: パスに空白があり、スクリプトが 0 以外で終わっても、終了コード 0 で終わる`, () => {
      const projectDir = join(mkdtempSync(join(tmpdir(), 'japanese-guard-')), 'a b');
      mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
      writeFileSync(join(projectDir, '.claude', 'hooks', 'japanese-guard.py'), 'import sys\nsys.exit(3)\n');
      const result = run(commandOf(event), projectDir, STOP_INPUT);
      assert.deepEqual(result, { status: 0, stdout: '' });
    });
  }
});
