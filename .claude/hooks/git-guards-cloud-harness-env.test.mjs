// クラウドのセッションの起動元が付ける GIT_CONFIG_* の組だけでは、git に確認を挟まない。
// 組から外れる起動元の環境とコマンドの中の設定は確認に回し、gh pr merge の宛先の判定は変えない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCloudHarnessGitConfig, judgeBash } from './bash-rules.mjs';
import { HOOK_SESSION_ID } from './hook-test-session.mjs';

const context = { cwd: '/repo', branchOf: () => '21-x' };
const decision = (command, env) => judgeBash(command, { ...context, env })?.[0] ?? 'allow';
const SHA = 'a'.repeat(40);

const HARNESS = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'credential.interactive',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_1: 'git@github.com:',
  GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
};

// 組の判定はサブコマンドを問わない。push の先の判定（main、production、v* の deny）は別に効く
for (const command of [
  'git status',
  'git diff origin/main...HEAD -- test/operations/pointers.ts; grep -n "sameSite" src/shared/session-cookie.ts | head -5',
  'git log --oneline -3',
  'git show HEAD',
  'bash -c "git status"',
  'git push -u origin 21-x',
]) {
  test(`[通す: クラウドの起動元の組] ${command}`, () => assert.equal(decision(command, { ...HARNESS }), 'allow'));
}

test('[止める: クラウドの起動元の組でも] main への push', () => assert.equal(decision('git push origin main', { ...HARNESS }), 'deny'));

// gh の宛先を替えうる GIT_CONFIG_COUNT は、組でも従来どおり起動元にあるものとして見る
test('[止める: クラウドの起動元の組でも] gh pr merge は宛先を判定できないので deny', () => {
  assert.equal(decision(`gh pr merge --squash --match-head-commit ${SHA}`, { ...HARNESS }), 'deny');
});

for (const command of [
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git log',
  'export GIT_CONFIG_GLOBAL=/tmp/x; git log',
  // COUNT を変えずに番号の外へ足す、COUNT だけを増やす
  'GIT_CONFIG_KEY_3=core.hooksPath GIT_CONFIG_VALUE_3=/x git status',
  'export GIT_CONFIG_COUNT=4; git status',
  'export GIT_CONFIG_KEY_0=core.hooksPath; git status',
  'env GIT_CONFIG_COUNT=4 git status',
]) {
  test(`[確認: クラウドの起動元の組でも] コマンドの中の設定 ${command}`, () => assert.equal(decision(command, { ...HARNESS }), 'ask'));
}

const swapped = { ...HARNESS, GIT_CONFIG_VALUE_1: 'ssh://git@github.com/', GIT_CONFIG_VALUE_2: 'git@github.com:' };
const duplicated = { ...HARNESS, GIT_CONFIG_VALUE_2: 'git@github.com:' };
for (const [name, env] of [
  ['違うキー', { ...HARNESS, GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/tmp' }],
  ['違う値', { ...HARNESS, GIT_CONFIG_VALUE_1: 'https://example.com/' }],
  ['大文字小文字の違うキー', { ...HARNESS, GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadof' }],
  ['COUNT が多い', { ...HARNESS, GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: 'core.pager', GIT_CONFIG_VALUE_3: 'cat' }],
  ['COUNT の外の番号', { ...HARNESS, GIT_CONFIG_KEY_3: 'core.pager', GIT_CONFIG_VALUE_3: 'cat' }],
  ['組の一部だけ', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.interactive', GIT_CONFIG_VALUE_0: 'false' }],
  ['並べ替え', swapped],
  ['重複', duplicated],
  ['ほかの GIT_CONFIG_*', { ...HARNESS, GIT_CONFIG_GLOBAL: '/tmp/x' }],
  ['空のほかの GIT_CONFIG_*', { ...HARNESS, GIT_CONFIG_GLOBAL: '' }],
  ['GIT_CONFIG_PARAMETERS', { ...HARNESS, GIT_CONFIG_PARAMETERS: "'core.pager=cat'" }],
  ['COUNT が無い', { ...HARNESS, GIT_CONFIG_COUNT: undefined }],
  ['COUNT が数の形でない', { ...HARNESS, GIT_CONFIG_COUNT: '03' }],
]) {
  test(`[確認: 組から外れる起動元] ${name}`, () => {
    const before = { ...env };
    assert.equal(isCloudHarnessGitConfig(env), false);
    assert.equal(decision('git status', env), 'ask');
    assert.deepEqual(env, before);
  });
}

test('値の無い（undefined の）ほかの GIT_CONFIG_* は、無いものとして組を判定する', () => {
  assert.equal(isCloudHarnessGitConfig({ ...HARNESS, GIT_CONFIG_GLOBAL: undefined }), true);
  assert.equal(decision('git status', { ...HARNESS, GIT_CONFIG_GLOBAL: undefined }), 'allow');
});

// 入口の guard-bash.mjs が、起動元の process.env から GIT_CONFIG_* を拾って判定に渡すことを確かめる
test('guard-bash.mjs は起動元の組では git を通し、組から外れれば確認に回す', () => {
  const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard-bash.mjs');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_CONFIG_/.test(name)));
  const run = (env) => {
    const input = JSON.stringify({ tool_input: { command: 'git log --oneline -1' }, session_id: HOOK_SESSION_ID, cwd: repo });
    const result = spawnSync(process.execPath, [hook], { input, env: { ...base, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };
  assert.equal(run(HARNESS), 'allow');
  assert.equal(run({ ...HARNESS, GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: 'core.hooksPath', GIT_CONFIG_VALUE_3: '/x' }), 'ask');
});
