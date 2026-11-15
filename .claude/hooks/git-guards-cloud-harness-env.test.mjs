// クラウドのセッションの起動元が付ける GIT_CONFIG_* の組では、読むだけの git に確認を挟まない。
// 組から外れる起動元の環境は、従来どおり確認に回す。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash, withoutCloudHarnessGitConfig } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '21-x' };
const decision = (command, env) => judgeBash(command, { ...context, env })?.[0] ?? 'allow';

const HARNESS = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'credential.interactive',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_1: 'git@github.com:',
  GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
};

for (const command of [
  'git status',
  'git diff origin/main...HEAD -- test/operations/pointers.ts; grep -n "sameSite" src/shared/session-cookie.ts | head -5',
  'git log --oneline -3',
  'git show HEAD',
  'bash -c "git status"',
  'git push -u origin 21-x',
]) {
  test(`[通す: クラウドの起動元] ${command}`, () => assert.equal(decision(command, { ...HARNESS }), 'allow'));
}

test('[止める: クラウドの起動元でも] main への push', () => assert.equal(decision('git push origin main', { ...HARNESS }), 'deny'));

test('[確認: クラウドの起動元でも] コマンドの中の GIT_CONFIG_* の設定', () => {
  assert.equal(decision('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git log', { ...HARNESS }), 'ask');
  assert.equal(decision('export GIT_CONFIG_GLOBAL=/tmp/x; git log', { ...HARNESS }), 'ask');
});

for (const [name, env] of [
  ['違うキー', { ...HARNESS, GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/tmp' }],
  ['違う値', { ...HARNESS, GIT_CONFIG_VALUE_1: 'https://example.com/' }],
  ['COUNT が多い', { ...HARNESS, GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: 'core.pager', GIT_CONFIG_VALUE_3: 'cat' }],
  ['COUNT の外の番号', { ...HARNESS, GIT_CONFIG_KEY_3: 'core.pager', GIT_CONFIG_VALUE_3: 'cat' }],
  ['ほかの GIT_CONFIG_*', { ...HARNESS, GIT_CONFIG_GLOBAL: '/tmp/x' }],
  ['GIT_CONFIG_PARAMETERS', { ...HARNESS, GIT_CONFIG_PARAMETERS: "'core.pager=cat'" }],
  ['COUNT が無い', { GIT_CONFIG_KEY_0: 'credential.interactive', GIT_CONFIG_VALUE_0: 'false' }],
  ['COUNT が数でない', { ...HARNESS, GIT_CONFIG_COUNT: '3 ' }],
]) {
  test(`[確認: 組から外れる起動元] ${name}`, () => {
    const before = { ...env };
    assert.equal(decision('git status', env), 'ask');
    assert.deepEqual(withoutCloudHarnessGitConfig(env), env);
    assert.deepEqual(env, before);
  });
}

test('組だけを除き、ほかの変数は残す', () => {
  assert.deepEqual(withoutCloudHarnessGitConfig({ ...HARNESS, CDPATH: '/x' }), { CDPATH: '/x' });
});
