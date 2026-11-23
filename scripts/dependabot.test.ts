import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { Minimatch } from 'minimatch';

// .github/dependabot.yml の形を確かめる（docs/development.md の「定期の作業」）
type Update = {
  'package-ecosystem': string;
  directory?: string;
  directories?: string[];
  groups?: Record<string, { patterns?: string[] }>;
  cooldown?: { 'default-days'?: number };
  'commit-message'?: { prefix?: string; include?: string };
  ignore?: { 'dependency-name': string }[];
};

const config = load(readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')) as {
  updates: Update[];
};

function update(ecosystem: string): Update {
  const found = config.updates.filter((u) => u['package-ecosystem'] === ecosystem);
  assert.equal(found.length, 1, ecosystem);
  return found[0]!;
}

test('npm と github-actions の2つを、それぞれ1つのグループにまとめ、公開から7日置いて出す', () => {
  assert.deepEqual(config.updates.map((u) => u['package-ecosystem']).sort(), ['github-actions', 'npm']);
  for (const u of config.updates) {
    const groups = Object.values(u.groups ?? {});
    assert.equal(groups.length, 1, u['package-ecosystem']);
    assert.deepEqual(groups[0]!.patterns, ['*'], u['package-ecosystem']);
    assert.equal(u.cooldown?.['default-days'], 7, u['package-ecosystem']);
  }
});

test('github-actions は、自前の composite action のすべてのディレクトリも見る', () => {
  const globs = (update('github-actions').directories ?? []).map((g) => new Minimatch(g));
  const actions = readdirSync(new URL('../.github/actions/', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `/.github/actions/${d.name}`);
  assert.ok(actions.length > 0);
  for (const dir of ['/', ...actions]) {
    assert.ok(
      globs.some((g) => g.match(dir)),
      dir,
    );
  }
});

test('claude-code-action は人が起動経路を確かめて上げるので、Dependabot では上げない', () => {
  const names = (update('github-actions').ignore ?? []).map((i) => i['dependency-name']);
  assert.ok(names.includes('anthropics/claude-code-action'));
});

test('件名は PR のタイトルの種別に合わせ、npm は chore、github-actions は ci の種別にし、括弧に deps の範囲を付ける', () => {
  assert.deepEqual(update('npm')['commit-message'], { prefix: 'chore', include: 'scope' });
  assert.deepEqual(update('github-actions')['commit-message'], { prefix: 'ci', include: 'scope' });
});
