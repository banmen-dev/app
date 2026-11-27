import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: boolean;
};
const workflow = load(readFileSync(new URL('../.github/workflows/ai-review.yml', import.meta.url), 'utf8')) as {
  jobs: { review: { env: Record<string, string>; steps: Step[] } };
};
const steps = workflow.jobs.review.steps;
function named(name: string): Step {
  const step = steps.find((step) => step.name === name);
  assert.ok(step?.run, `${name} の run が無い`);
  return step;
}
const prepare = () => named('実行用の base を用意する');
const overlay = () => named('レビューする作業場所を head にする');

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'ai-review-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'workspace');
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (step: Step, env: Record<string, string>) =>
    spawnSync('bash', ['-c', step.run!], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const read = (path: string) => readFileSync(join(dir, path), 'utf8');
  return { root, dir, git, write, commit, run, read };
}

test('base の用意は checkout の直後、上書きは差分の後かつ action の直前で、失敗を無視しない', () => {
  const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
  const action = steps.findIndex((step) => step.uses?.startsWith('anthropics/claude-code-action@'));
  assert.equal(steps.indexOf(prepare()), checkout + 1);
  assert.equal(prepare()['continue-on-error'], undefined);
  assert.equal(prepare().env?.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(prepare().env?.TRUSTED_DIR, '${{ runner.temp }}/ai-review-base');
  for (const step of steps.filter((step) => /(?:^|\n)\s*node\s/.test(step.run ?? ''))) {
    assert.equal(step.env?.TRUSTED_DIR, prepare().env?.TRUSTED_DIR);
  }
  assert.ok(steps.findIndex((step) => step.name === '差分を書き出す') < steps.indexOf(overlay()));
  assert.equal(steps.indexOf(overlay()), action - 1);
  assert.equal(overlay().if, "steps.diff.outputs.mode != 'none'");
  assert.equal(overlay()['continue-on-error'], undefined);
  assert.equal(overlay().env?.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  for (const step of [prepare(), overlay()]) assert.match(step.run!, /set -euo pipefail/);
});

test('追加・変更・削除・リネームを head にし、symlink を通常のファイルで取り出す', (t) => {
  const f = fixture(t);
  f.write('changed.txt', 'base');
  f.write('deleted.txt', 'base');
  f.write('old.txt', 'rename');
  f.write('link-target.txt', 'target');
  f.write('regular-to-link', 'base');
  symlinkSync('link-target.txt', join(f.dir, 'existing-link'));
  symlinkSync('link-target.txt', join(f.dir, 'unchanged-link'));
  const base = f.commit('base');
  f.write('changed.txt', 'head');
  f.write('新しいファイル.txt', 'added');
  f.git('rm', 'deleted.txt');
  f.git('mv', 'old.txt', 'renamed.txt');
  rmSync(join(f.dir, 'regular-to-link'));
  symlinkSync('/outside/must-not-be-read', join(f.dir, 'regular-to-link'));
  symlinkSync('link-target.txt', join(f.dir, 'new-link'));
  rmSync(join(f.dir, 'existing-link'));
  symlinkSync('changed.txt', join(f.dir, 'existing-link'));
  const head = f.commit('head');
  f.git('checkout', '-q', base);
  const result = f.run(overlay(), { HEAD_SHA: head });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read('changed.txt'), 'head');
  assert.equal(f.read('新しいファイル.txt'), 'added');
  assert.ok(!existsSync(join(f.dir, 'deleted.txt')));
  assert.ok(!existsSync(join(f.dir, 'old.txt')));
  assert.equal(f.read('renamed.txt'), 'rename');
  for (const [path, text] of [
    ['new-link', 'link-target.txt'],
    ['existing-link', 'changed.txt'],
    ['regular-to-link', '/outside/must-not-be-read'],
  ]) {
    assert.ok(lstatSync(join(f.dir, path!)).isFile(), path);
    assert.equal(f.read(path!), text);
  }
  assert.ok(lstatSync(join(f.dir, 'unchanged-link')).isSymbolicLink());
  assert.equal(f.read('unchanged-link'), 'target');
  assert.equal(f.git('rev-parse', 'HEAD'), base, '実行する base の参照を動かさない');
});

const protectedPaths = [
  'bunfig.toml',
  '.env.example',
  '.claude/settings.json',
  '.claude/skills/review/SKILL.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.mcp.json',
  'src/.claude/skills/review/SKILL.md',
  'src/CLAUDE.md',
  'src/CLAUDE.local.md',
  'src/.mcp.json',
  'src/deep/.ClAuDe/settings.json',
  'src/deep/cLaUdE.Md',
  'src/deep/claude.LOCAL.md',
  'src/deep/.MCP.JSON',
  'file/.claude',
  'file/deep/.ClAuDe',
];
for (const operation of ['change', 'add', 'delete'] as const) {
  test(`自動で読む場所は入れ子・大文字小文字・同名ファイルも含めて base に残す: ${operation}`, (t) => {
    const f = fixture(t);
    f.write('ordinary.txt', 'base');
    if (operation !== 'add') for (const path of protectedPaths) f.write(path, 'base');
    const base = f.commit('base');
    if (operation === 'delete') {
      for (const path of protectedPaths) f.git('rm', path);
    } else {
      for (const path of protectedPaths) f.write(path, 'head');
    }
    const head = f.commit('head');
    f.git('checkout', '-q', base);
    const result = f.run(overlay(), { HEAD_SHA: head });
    assert.equal(result.status, 0, result.stderr);
    for (const path of protectedPaths) {
      if (operation === 'add') assert.ok(!existsSync(join(f.dir, path)), path);
      else assert.equal(f.read(path), 'base', path);
    }
  });
}

test('ワークフローの全 node スクリプトは head に上書きされた後も別の base から走る', (t) => {
  const f = fixture(t);
  f.write('package.json', '{"type":"module"}');
  const scripts = ['github-write-permissions', 'ai-review-scope', 'ai-review-context', 'ai-review-summary'];
  for (const name of scripts)
    f.write(
      `scripts/${name}.ts`,
      "import { basename } from 'node:path'; console.log('BASE:' + basename(import.meta.filename));",
    );
  const base = f.commit('base');
  for (const name of scripts) f.write(`scripts/${name}.ts`, "throw new Error('HEAD のコードを実行してはいけない');");
  f.write('package.json', '{"type":"commonjs"}');
  const head = f.commit('head');
  f.git('checkout', '-q', base);
  const trustedDir = join(f.root, 'trusted base');
  const env = { BASE_SHA: base, HEAD_SHA: head, TRUSTED_DIR: trustedDir };
  const prepared = f.run(prepare(), env);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: trustedDir, encoding: 'utf8' }).trim(), base);
  assert.equal(f.run(overlay(), env).status, 0);
  assert.equal(f.read('package.json'), '{"type":"commonjs"}');
  // 包む書き方や別ランタイムを足しても、base の起動検査を素通りさせない。
  const commands = steps.flatMap((step) =>
    (step.run ?? '')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line) && /\b(?:node|pnpm|npm|npx|bun|yarn|deno)\b/.test(line)),
  );
  assert.equal(commands.length, scripts.length);
  for (const command of commands) {
    assert.match(command, /^\s*node "\$TRUSTED_DIR\/scripts\/[\w-]+\.ts"(?:\s|$)/);
    const result = spawnSync('bash', ['-c', command], {
      cwd: f.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        RAW_DIR: f.root,
        CONTEXT_DIR: f.root,
        OUT_FILE: join(f.root, 'summary'),
        BODY_FILE: join(f.root, 'body'),
        MARK_SHA: head,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^BASE:/);
  }
});

test('存在しない head では上書きが失敗する', (t) => {
  const f = fixture(t);
  f.write('a.txt', 'base');
  f.commit('base');
  assert.notEqual(f.run(overlay(), { HEAD_SHA: 'f'.repeat(40) }).status, 0);
});

for (const type of ['file', 'symlink'] as const) {
  test(`保護対象の祖先が ${type} になる head は、保護対象を消す前に失敗する`, (t) => {
    const f = fixture(t);
    f.write('src/deep/CLAUDE.md', 'base instructions');
    f.write('src/.claude/settings.json', 'base settings');
    const base = f.commit('base');
    f.git('rm', '-r', 'src');
    if (type === 'file') f.write('src', 'head');
    else symlinkSync('/outside/must-not-be-read', join(f.dir, 'src'));
    const head = f.commit('head');
    f.git('checkout', '-q', base);
    const result = f.run(overlay(), { HEAD_SHA: head });
    assert.notEqual(result.status, 0, '保護対象の祖先を置き換えてはいけない');
    assert.equal(f.read('src/deep/CLAUDE.md'), 'base instructions');
    assert.equal(f.read('src/.claude/settings.json'), 'base settings');
  });
}

for (const path of ['.claude', 'src/.ClAuDe', 'src/.claude/skills/review']) {
  test(`保護領域内の ${path} が head でファイルになっても、base を残してレビューする`, (t) => {
    const f = fixture(t);
    const protectedFile = `${path}/SKILL.md`;
    f.write(protectedFile, 'base');
    f.write('ordinary.txt', 'base');
    const base = f.commit('base');
    f.git('rm', '-r', path);
    f.write(path, 'head');
    f.write('ordinary.txt', 'head');
    const head = f.commit('head');
    f.git('checkout', '-q', base);
    const result = f.run(overlay(), { HEAD_SHA: head });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.read(protectedFile), 'base');
    assert.equal(f.read('ordinary.txt'), 'head');
  });
}

for (const path of [
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.mcp.json',
  'src/cLaUdE.Md',
  'src/CLAUDE.local.md',
  'src/.MCP.JSON',
]) {
  for (const existsInBase of [true, false]) {
    test(`保護対象 ${path} を head でディレクトリにしても base の状態を維持する: ${existsInBase ? '元ファイルあり' : '元ファイルなし'}`, (t) => {
      const f = fixture(t);
      f.write('ordinary.txt', 'base');
      if (existsInBase) f.write(path, 'base protected');
      const base = f.commit('base');
      if (existsInBase) f.git('rm', path);
      f.write(`${path}/child.txt`, 'head content');
      f.write('ordinary.txt', 'head');
      const head = f.commit('head');
      f.git('checkout', '-q', base);
      const result = f.run(overlay(), { HEAD_SHA: head });
      assert.equal(result.status, 0, result.stderr);
      if (existsInBase) assert.equal(f.read(path), 'base protected');
      else assert.ok(!existsSync(join(f.dir, path)));
      assert.equal(f.read('ordinary.txt'), 'head');
    });
  }
}

test('head で上書きした後の action・コマンド・環境変数は既知のものだけ', () => {
  const after = steps.slice(steps.indexOf(overlay()) + 1);
  assert.deepEqual(
    after.map((step) => step.uses ?? step.name),
    [
      'anthropics/claude-code-action@ae68417a745a5df4b2124873632bd73a2255e6f6',
      'まとめを PR に付ける',
      'ai-review のラベルを外す',
    ],
  );
  assert.deepEqual(workflow.jobs.review.env, {
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  });
  const expectedEnvKeys: Record<string, string[]> = {
    書いた人の書き込み権限を確認する: ['TRUSTED_DIR', 'GH_TOKEN', 'REPO', 'RAW_DIR'],
    起点を決める: [
      'TRUSTED_DIR',
      'RAW_DIR',
      'CONTEXT_DIR',
      'BASE_SHA',
      'HEAD_SHA',
      'EVENT_ACTION',
      'NO_DIFF_BODY_FILE',
    ],
    'PR の本文とコメントを整える': ['TRUSTED_DIR', 'RAW_DIR', 'CONTEXT_DIR'],
    'まとめを PR に付ける': ['TRUSTED_DIR', 'GH_TOKEN', 'REPO', 'PR_NUMBER', 'OUT_FILE', 'BODY_FILE', 'MARK_SHA'],
    'ai-review のラベルを外す': ['GH_TOKEN', 'REPO', 'PR_NUMBER'],
  };
  for (const [name, keys] of Object.entries(expectedEnvKeys)) {
    assert.deepEqual(Object.keys(named(name).env ?? {}).sort(), keys.sort(), name);
  }
  assert.deepEqual(after[0]?.env, { CLAUDE_CODE_REMOTE: 'false', JAPANESE_GUARD_DISABLE: '1' });
  assert.equal(after[0]?.run, undefined);
  assert.equal(
    after[1]?.run,
    'set -euo pipefail\nnode "$TRUSTED_DIR/scripts/ai-review-summary.ts" "$OUT_FILE" "$BODY_FILE" "$MARK_SHA"\ngh pr comment "$PR_NUMBER" -R "$REPO" --body-file "$BODY_FILE"\n',
  );
  assert.equal(after[2]?.run, 'gh api -X DELETE "repos/$REPO/issues/$PR_NUMBER/labels/ai-review"');
});
