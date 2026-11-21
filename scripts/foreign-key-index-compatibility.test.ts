import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fillSeedDates } from './seed-dates.ts';

const migrations = new URL('../migrations/', import.meta.url);
const migration = '0040_add_foreign_key_indexes.sql';
const hotRepository = 'review-fixture-repository';

function insertRows(db: DatabaseSync, table: 'stories' | 'tasks', template: Record<string, SQLOutputValue>) {
  const columns = Object.keys(template);
  const insert = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  return (overrides: Record<string, SQLOutputValue>) => {
    const row = { ...template, ...overrides };
    insert.run(...columns.map((column) => row[column]!));
  };
}

function beforeMigration() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql') && name < migration)
    .sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const seed = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
  db.exec(fillSeedDates(seed, new Date('2026-11-21T12:00:00Z')));
  const workspace = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get()?.id;
  assert.ok(typeof workspace === 'string');
  const story = db.prepare('SELECT * FROM stories WHERE workspace_id = ? LIMIT 1').get(workspace);
  const task = db.prepare('SELECT * FROM tasks WHERE workspace_id = ? LIMIT 1').get(workspace);
  assert.ok(story && task && typeof task.created_by === 'string');
  db.prepare(
    "INSERT INTO repositories (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Fixture', 'a0', ?, ?)",
  ).run(hotRepository, workspace, task.created_at!, task.updated_at!);

  const insertStory = insertRows(db, 'stories', story);
  const insertTask = insertRows(db, 'tasks', task);
  db.exec('BEGIN');
  for (let storyNumber = 0; storyNumber < 3000; storyNumber++) {
    const storyId = `review-story-${storyNumber}`;
    insertStory({ id: storyId, epic_id: null, deleted_at: null, completed_at: null, completed_by: null });
    for (let taskNumber = 0; taskNumber < 20; taskNumber++) {
      insertTask({
        id: `review-task-${storyNumber}-${taskNumber}`,
        story_id: storyId,
        assignee_user_id: taskNumber < 16 ? task.created_by : null,
        repository_id: taskNumber < 15 ? hotRepository : null,
        tray: 'backlog',
        deleted_at: null,
        sprint_id: null,
        column_id: null,
        column_position: null,
        completed_at: null,
        completed_by: null,
      });
    }
  }
  db.exec('COMMIT');
  return { db, workspace: workspace, owner: task.created_by };
}

// 0040 の前のバックログから、タスクとリポジトリを読む条件を抜き出した文で、旧版の索引選択を確かめる。
const taskConditions = `tasks.story_id = stories.id AND tasks.workspace_id = stories.workspace_id
  AND stories.workspace_id = ? AND stories.deleted_at IS NULL AND tasks.tray = 'backlog' AND tasks.deleted_at IS NULL`;
const oldList = `SELECT tasks.id, repositories.name FROM stories CROSS JOIN tasks
  LEFT JOIN repositories ON repositories.id = tasks.repository_id
    AND repositories.workspace_id = stories.workspace_id AND repositories.deleted_at IS NULL
  WHERE ${taskConditions} AND tasks.completed_at IS NULL`;
const oldCounts = `SELECT stories.id, count(tasks.completed_at), sum(tasks.points) FROM stories CROSS JOIN tasks
  WHERE ${taskConditions} GROUP BY stories.id`;

function taskLookup(db: DatabaseSync, sql: string, ...args: string[]): string {
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => row.detail)
    .join('\n');
  const lookup = plan.split('\n').find((detail) => /^SEARCH tasks /.test(detail));
  assert.ok(lookup, plan);
  return lookup;
}

function assertRepositoryLookup(db: DatabaseSync, workspace: string) {
  const lookup = taskLookup(db, `${oldList} AND repositories.id = ?`, workspace, hotRepository);
  assert.match(lookup, /story_id=\?/);
  if (lookup.includes('tasks_repository_fk')) {
    assert.match(lookup, /\(repository_id=\? AND story_id=\? AND deleted_at=\? AND completed_at=\?\)/);
  }
}

test('0040 を統計のない旧版の DB に当てても、リポジトリ指定ではストーリーごとに絞る', () => {
  const { db, workspace, owner } = beforeMigration();
  try {
    db.exec(readFileSync(new URL(migration, migrations), 'utf8'));
    assertRepositoryLookup(db, workspace);
    // この構成では旧版の一覧と集計がワークスペースの範囲を引き直しうる。新版の索引指定は D1 のテストで確かめる。
    for (const lookup of [
      taskLookup(db, oldList, workspace),
      taskLookup(db, `${oldList} AND +tasks.assignee_user_id = ?`, workspace, owner),
      taskLookup(db, oldCounts, workspace),
    ]) {
      assert.match(lookup, /story_id=\?|workspace_id=\? AND tray=\?/);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('0040 を既存統計のある旧版の DB に当てても、バックログをストーリーごとに絞る', () => {
  const { db, workspace, owner } = beforeMigration();
  try {
    db.exec('ANALYZE');
    db.exec(readFileSync(new URL(migration, migrations), 'utf8'));
    assertRepositoryLookup(db, workspace);
    for (const lookup of [
      taskLookup(db, oldList, workspace),
      taskLookup(db, `${oldList} AND +tasks.assignee_user_id = ?`, workspace, owner),
      taskLookup(db, oldCounts, workspace),
    ]) {
      assert.match(lookup, /story_id=\?/);
    }
  } finally {
    db.close();
  }
});
