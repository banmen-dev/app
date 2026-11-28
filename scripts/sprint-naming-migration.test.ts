// 既存行を持つ旧スキーマへ0036を当て、終了・削除・別workspaceの数え方と制約を検証する。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fillSeedDates } from './seed-dates.ts';
import { withEpicRewardTier } from './legacy-seed.ts';

const migrations = new URL('../migrations/', import.meta.url);
const migration = readFileSync(new URL('0036_add_workspace_sprint_naming.sql', migrations), 'utf8');

test('既存の次番号は削除していない全状態のスプリント数＋1、0件は1。既存データと索引を保つ', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql') && name < '0036_')
      .sort()) {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
    // 0038の依頼回と0039のプランを使う契約を除き、旧スキーマへ入れる。
    const seed = withEpicRewardTier(
      fillSeedDates(readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8'), new Date()),
    );
    const legacySeed = seed
      .replace(/^UPDATE task_sources SET review_cycle = .*;$/gm, '')
      .replace(/^INSERT INTO review_request_cycles\b[^;]*;/gm, '')
      .replace(/^INSERT INTO organization_contracts\b[^;]*;/gm, '');
    assert.notEqual(legacySeed, seed, '0038・0039のseedを旧スキーマ用に除いている');
    assert.ok(!legacySeed.includes('UPDATE task_sources SET review_cycle ='), '0038の依頼回の更新が残っている');
    assert.ok(!legacySeed.includes('INSERT INTO review_request_cycles'), '0038の依頼回の行が残っている');
    assert.ok(!legacySeed.includes('INSERT INTO organization_contracts'), '0039のプランを使う契約の行が残っている');
    db.exec(legacySeed);
    // seed の全スプリントを外して、状態と削除を明示する。
    // seed の関連行の外部キーを保つため、行を消すのではなく新しいworkspaceへ追加する。
    const source = db
      .prepare('SELECT id, organization_id, created_by, created_at, updated_at FROM workspaces LIMIT 1')
      .get()!;
    const addWorkspace = db.prepare(
      'INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const id of ['naming-one', 'naming-zero', 'naming-other']) {
      addWorkspace.run(
        id,
        source.organization_id!,
        id,
        'Asia/Tokyo',
        source.created_by!,
        source.created_at!,
        source.updated_at!,
      );
    }
    const addSprint = db.prepare(
      'INSERT INTO sprints (id, workspace_id, name, start_on, end_on, status, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [id, workspace, status, deleted, date] of [
      ['a', 'naming-one', 'planned', null, '2026-01-05'],
      ['b', 'naming-one', 'active', null, '2026-01-12'],
      ['c', 'naming-one', 'closed', null, '2026-01-19'],
      ['d', 'naming-one', 'planned', '2026-01-01T00:00:00.000Z', '2026-01-26'],
      ['e', 'naming-other', 'planned', null, '2026-02-02'],
    ]) {
      addSprint.run(id!, workspace!, id!, date!, date!, status!, deleted!, source.created_at!, source.updated_at!);
    }
    const indexes = () =>
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name").all();
    const beforeIndexes = indexes();
    const beforeSprints = db.prepare('SELECT * FROM sprints ORDER BY id').all();
    db.exec(migration);
    for (const [workspace, next] of [
      ['naming-one', 4],
      ['naming-zero', 1],
      ['naming-other', 2],
    ] as const) {
      const row = db
        .prepare('SELECT sprint_name_template, sprint_number_next FROM workspaces WHERE id = ?')
        .get(workspace)!;
      assert.equal(row.sprint_name_template, null);
      assert.equal(row.sprint_number_next, next);
    }
    assert.deepEqual(db.prepare('SELECT * FROM sprints ORDER BY id').all(), beforeSprints);
    assert.deepEqual(indexes(), beforeIndexes);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(
      () => db.prepare('UPDATE workspaces SET sprint_number_next = 0 WHERE id = ?').run('naming-one'),
      /CHECK/,
    );
    assert.throws(
      () => db.prepare('UPDATE workspaces SET sprint_number_next = NULL WHERE id = ?').run('naming-one'),
      /NOT NULL/,
    );
    assert.throws(
      () =>
        db.prepare('UPDATE workspaces SET sprint_name_template = ? WHERE id = ?').run('x'.repeat(101), 'naming-one'),
      /CHECK/,
    );
    db.prepare('UPDATE workspaces SET sprint_name_template = ? WHERE id = ?').run('😀'.repeat(100), 'naming-one');
    // 一つ前のコードと同じ、追加列を指定しないINSERTも既定値で使える。
    addWorkspace.run(
      'old-code',
      source.organization_id!,
      'old-code',
      'Asia/Tokyo',
      source.created_by!,
      source.created_at!,
      source.updated_at!,
    );
    assert.equal(
      db.prepare('SELECT sprint_number_next FROM workspaces WHERE id = ?').get('old-code')!.sprint_number_next,
      1,
    );
  } finally {
    db.close();
  }
});
