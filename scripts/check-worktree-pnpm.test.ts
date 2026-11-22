import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findWorktreePnpmInstalls } from './check-worktree-pnpm.ts';

const guide = '[ワークツリーで作業する](development.md#ワークツリーで作業する)';
const fence = (commands: string) => '\x60\x60\x60sh\n' + commands + '\n\x60\x60\x60';

describe('ワークツリーの pnpm 保存先の確認', () => {
  const path = 'docs/setup.md';

  test('文章でワークツリーに依存を入れる手順を検出する', () => {
    assert.deepEqual(findWorktreePnpmInstalls(path, '# 用意\n\nワークツリーで `pnpm install` を実行する。\n'), [3]);
  });

  test('同じ節で作成したワークツリーの依存導入を検出する', () => {
    const content = `### 手元の準備\n\n${fence('git worktree add worktrees/example origin/main')}\n\n${fence('cd worktrees/example\npnpm install --frozen-lockfile')}`;
    assert.deepEqual(findWorktreePnpmInstalls(path, content), [9]);
  });

  test('見出しからワークツリーの手順と分かるとき、子の節や箇条書きでも検出する', () => {
    const content = '### ワークツリーの準備\n\n#### 依存\n\n1. Node の版を確認する。\n2. `pnpm i` を実行する。';
    assert.deepEqual(findWorktreePnpmInstalls(path, content), [6]);
  });

  test('作業場所を説明した直後の番号付き手順を検出する', () => {
    const content = '手元のワークツリーを使う。\n\n1. Node の版を確認する。\n2. `pnpm install` を実行する。';
    assert.deepEqual(findWorktreePnpmInstalls(path, content), [4]);
  });

  test('直前の確認と、開発文書の該当節への参照を認める', () => {
    const explicit =
      'ワークツリーで保存先を確認する。\n\n' +
      fence('pnpm store path\npnpm install --frozen-lockfile --store-dir "$PWD/node_modules/.pnpm-store"');
    assert.deepEqual(findWorktreePnpmInstalls(path, explicit), []);
    assert.deepEqual(
      findWorktreePnpmInstalls(path, `ワークツリーでは ${guide} に従う。\n\n${fence('pnpm install')}`),
      [],
    );
    assert.deepEqual(
      findWorktreePnpmInstalls(path, `- ワークツリーで ${guide} に従い、` + '`pnpm install` を実行する。'),
      [],
    );
  });

  test('別の節や別の箇条書きにあるリンクでは通さない', () => {
    const content = `### 参照\n\n${guide}\n\n### ワークツリーの用意\n\n${fence('pnpm install')}`;
    assert.deepEqual(findWorktreePnpmInstalls(path, content), [8]);
    assert.deepEqual(
      findWorktreePnpmInstalls(
        path,
        `- README の ${guide} を更新する。\n` + '- ワークツリーで `pnpm install` を実行する。',
      ),
      [2],
    );
  });

  test('保存先を後から確認する手順、別の節へのリンクを検出する', () => {
    const late = `### ワークツリー\n\n${fence('pnpm install\npnpm store path')}`;
    assert.deepEqual(findWorktreePnpmInstalls(path, late), [4]);
    assert.deepEqual(
      findWorktreePnpmInstalls(
        path,
        'ワークツリーで [開発文書](development.md#ci) を読み、`pnpm install` を実行する。',
      ),
      [1],
    );
  });

  test('移動前の保存先表示や HTML コメント内の確認は対象の確認に数えない', () => {
    const shell = 'git worktree add worktrees/example origin/main\npnpm store path\ncd worktrees/example\npnpm install';
    assert.deepEqual(findWorktreePnpmInstalls('scripts/setup.sh', shell), [4]);
    const commented = '### ワークツリー\n\n<!-- pnpm store path を実行する -->\n' + fence('pnpm install');
    assert.deepEqual(findWorktreePnpmInstalls(path, commented), [5]);
    const separate = '### ワークツリー\n\n' + fence('pnpm store path') + '\n\n' + fence('pnpm install');
    assert.deepEqual(findWorktreePnpmInstalls(path, separate), []);
  });

  test('通常のセットアップや prepare の説明は対象外', () => {
    assert.deepEqual(findWorktreePnpmInstalls(path, `### クローン直後\n\n${fence('pnpm install')}`), []);
    assert.deepEqual(findWorktreePnpmInstalls(path, 'ワークツリーでは `pnpm install` の `prepare` が動く。'), []);
  });

  test('シェルスクリプトの作業場所を指定するインストールを検出する', () => {
    const shell = 'pnpm -C worktrees/example install --frozen-lockfile';
    assert.deepEqual(findWorktreePnpmInstalls('scripts/setup.sh', shell), [1]);
    assert.deepEqual(findWorktreePnpmInstalls('scripts/setup.sh', 'cd "$worktree"\npnpm install'), [2]);
    assert.deepEqual(findWorktreePnpmInstalls('scripts/setup.sh', 'pnpm store path\n' + shell), [2]);
    assert.deepEqual(findWorktreePnpmInstalls('scripts/setup.sh', 'pnpm -C worktrees/other store path\n' + shell), [2]);
    assert.deepEqual(
      findWorktreePnpmInstalls('scripts/setup.sh', 'pnpm -Cworktrees/example install --frozen-lockfile'),
      [1],
    );
    assert.deepEqual(
      findWorktreePnpmInstalls('scripts/setup.sh', 'pnpm store path\npnpm install -C worktrees/example'),
      [2],
    );
    assert.deepEqual(
      findWorktreePnpmInstalls('scripts/setup.sh', 'pnpm store path --dir=worktrees/example\n' + shell),
      [],
    );
    assert.deepEqual(
      findWorktreePnpmInstalls('scripts/setup.sh', 'pnpm -C worktrees/example store path\n' + shell),
      [],
    );
    assert.deepEqual(findWorktreePnpmInstalls('scripts/setup.sh', '# ワークツリーで手動で入れる\npnpm install'), []);
  });
});

test('CLI は Git 管理下の文書に違反があるとファイル名と行番号を出して失敗する', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'check-worktree-pnpm-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = 'docs/setup.md';
  const script = fileURLToPath(new URL('./check-worktree-pnpm.ts', import.meta.url));
  execFileSync('git', ['init', '-q'], { cwd });
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, path), '# ワークツリーの準備\n\n' + fence('pnpm install') + '\n');
  execFileSync('git', ['add', '--', path], { cwd });

  const failure = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /docs\/setup\.md:4: .*pnpm store path/);

  writeFileSync(join(cwd, path), '# ワークツリーの準備\n\n' + fence('pnpm store path\npnpm install') + '\n');
  const success = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
});
