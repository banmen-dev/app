import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// scripts/session-start.sh を、偽の /opt と .node-version で実際に走らせて確かめる（docs/development.md の「クラウド環境」）
const script = fileURLToPath(new URL('./session-start.sh', import.meta.url));
const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8')) as {
  hooks: Record<string, { hooks: { command: string }[] }[]>;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(opts: { nodeVersion?: string; fakeNode?: { major: string; prints: string } }) {
  const dir = mkdtempSync(join(tmpdir(), 'session-start-'));
  dirs.push(dir);
  const project = join(dir, 'project');
  const root = join(dir, 'opt');
  mkdirSync(project);
  mkdirSync(root);
  if (opts.nodeVersion !== undefined) writeFileSync(join(project, '.node-version'), opts.nodeVersion);
  if (opts.fakeNode) {
    const bin = join(root, `node${opts.fakeNode.major}`, 'bin');
    mkdirSync(bin, { recursive: true });
    const node = join(bin, 'node');
    writeFileSync(node, `#!/bin/sh\necho ${opts.fakeNode.prints}\n`);
    chmodSync(node, 0o755);
  }
  return { project, root, envFile: join(dir, 'env') };
}

function run(f: { project: string; root: string; envFile: string }, withEnvFile = true) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    CLAUDE_PROJECT_DIR: f.project,
    BANMEN_NODE_ROOT: f.root,
  };
  if (withEnvFile) env.CLAUDE_ENV_FILE = f.envFile;
  return spawnSync('bash', [script], { env, encoding: 'utf8' });
}

describe('session-start.sh', () => {
  test('/opt/node<主版>/bin/node が動けば、PATH の先頭に足す行を書く', () => {
    const f = fixture({ nodeVersion: '26\n', fakeNode: { major: '26', prints: 'v26.13.1' } });
    const r = run(f);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(f.envFile, 'utf8'), `export PATH="${f.root}/node26/bin:$PATH"\n`);
  });

  test('.node-version が x.y.z でも主版を使う', () => {
    const f = fixture({ nodeVersion: 'v26.13.1\n', fakeNode: { major: '26', prints: 'v26.13.1' } });
    assert.equal(run(f).status, 0);
    assert.match(readFileSync(f.envFile, 'utf8'), /node26\/bin/);
  });

  test('二度走らせても同じ行を重ねない', () => {
    const f = fixture({ nodeVersion: '26', fakeNode: { major: '26', prints: 'v26.13.1' } });
    run(f);
    run(f);
    assert.equal(readFileSync(f.envFile, 'utf8').trim().split('\n').length, 1);
  });

  test('/opt/node<主版> が無ければ何も書かず 0 で終わる', () => {
    const f = fixture({ nodeVersion: '26' });
    const r = run(f);
    assert.equal(r.status, 0);
    assert.equal(existsSync(f.envFile), false);
  });

  test('node の版が主版と合わなければ何も書かない', () => {
    const f = fixture({ nodeVersion: '26', fakeNode: { major: '26', prints: 'v22.23.5' } });
    assert.equal(run(f).status, 0);
    assert.equal(existsSync(f.envFile), false);
  });

  test('CLAUDE_ENV_FILE が無ければ何も書かず 0 で終わる', () => {
    const f = fixture({ nodeVersion: '26', fakeNode: { major: '26', prints: 'v26.13.1' } });
    assert.equal(run(f, false).status, 0);
    assert.equal(existsSync(f.envFile), false);
  });

  test('.node-version が無い、主版でない値のときも何も書かず 0 で終わる', () => {
    for (const nodeVersion of [undefined, 'lts/*', '../x', '26"; touch pwned; "']) {
      const f = fixture({ nodeVersion, fakeNode: { major: '26', prints: 'v26.13.1' } });
      assert.equal(run(f).status, 0);
      assert.equal(existsSync(f.envFile), false);
    }
  });

  test('既存の最終行が改行で終わっていなくても、行を連結しない', () => {
    const f = fixture({ nodeVersion: '26', fakeNode: { major: '26', prints: 'v26.13.1' } });
    writeFileSync(f.envFile, 'export FOO=bar');
    run(f);
    assert.equal(readFileSync(f.envFile, 'utf8'), `export FOO=bar\nexport PATH="${f.root}/node26/bin:$PATH"\n`);
  });

  test('書き込めない CLAUDE_ENV_FILE でも 0 で終わり、何も出さない', () => {
    const f = fixture({ nodeVersion: '26', fakeNode: { major: '26', prints: 'v26.13.1' } });
    const r = run({ ...f, envFile: join(f.root, 'no', 'such', 'env') });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  // settings.json の command そのものを sh -c で走らせる（綴りやクォートの誤りも落とす）
  test('.claude/settings.json の SessionStart の command が、実際に PATH の行を書く', () => {
    const commands = (settings.hooks.SessionStart ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    const command = commands.find((c) => c.includes('session-start.sh'));
    assert.ok(command, 'SessionStart に session-start.sh のフックが無い');
    const f = fixture({ fakeNode: { major: '26', prints: 'v26.13.1' } });
    const repoRoot = fileURLToPath(new URL('../', import.meta.url));
    const r = spawnSync('sh', ['-c', command], {
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: repoRoot,
        CLAUDE_ENV_FILE: f.envFile,
        BANMEN_NODE_ROOT: f.root,
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(readFileSync(f.envFile, 'utf8'), `export PATH="${f.root}/node26/bin:$PATH"\n`);
    // スクリプトが無いときも 0
    const none = spawnSync('sh', ['-c', command], {
      env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: f.root },
      encoding: 'utf8',
    });
    assert.equal(none.status, 0);
  });
});
