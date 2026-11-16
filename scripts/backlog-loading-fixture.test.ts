import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  backlogActorId,
  backlogCases,
  backlogLoadingFixture,
  backlogPath,
  backlogSlug,
  backlogTaskCount,
  backlogWorkspaceId,
  backlogEmptyWorkspaceId,
} from './backlog-loading-fixture.ts';
import { filterFromParams, filterInput } from '../src/lib/backlog-filter.ts';

test('5条件のURLとAPI引数が対応し、操作開始と空表示を混ぜない', () => {
  assert.equal(backlogCases.length, 5);
  assert.deepEqual(
    backlogCases.map((item) => item.hasTask),
    [true, true, true, false, false],
  );
  for (const [index, item] of backlogCases.entries()) {
    const url = new URL(backlogPath(index), 'http://localhost');
    assert.equal(url.pathname, `/${backlogSlug}/w/${item.workspaceId}`);
    assert.deepEqual(filterInput(filterFromParams(url.searchParams)), item.input);
    assert.equal(item.targetTaskId !== null, item.hasTask);
  }
  assert.throws(() => backlogPath(5), /計測条件/);
});

test('実スキーマでfixtureを読み、memberの所属・木・絞り込み対象と非該当を確かめる', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    for (const suffix of ['101', '102']) {
      db.prepare('INSERT INTO accounts (id,created_at,updated_at) VALUES (?, ?, ?)').run(
        `019a0000-0000-7000-8000-000000000${suffix}`,
        '2026-11-16T00:00:00.000Z',
        '2026-11-16T00:00:00.000Z',
      );
    }
    assert.equal(backlogLoadingFixture(), backlogLoadingFixture());
    db.exec(backlogLoadingFixture());
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=?').get(backlogWorkspaceId)?.n,
      backlogTaskCount,
    );
    for (const table of ['epics', 'stories', 'tasks']) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`).get(backlogEmptyWorkspaceId)?.n,
        0,
      );
    }
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id=? AND role='member'").get(backlogActorId)?.n,
      2,
    );
    assert.equal(db.prepare('SELECT is_admin FROM users WHERE id=?').get(backlogActorId)?.is_admin, 0);
    for (const item of backlogCases) {
      const conditions = ['workspace_id=?'];
      const values = [item.workspaceId];
      if (item.input.assignee_user_id) {
        conditions.push('assignee_user_id=?');
        values.push(backlogActorId);
      }
      if (item.input.query) {
        conditions.push('title LIKE ?');
        values.push(`%${item.input.query}%`);
      }
      for (const field of ['category_id', 'repository_id']) {
        if (item.input[field]) {
          conditions.push(`${field}=?`);
          values.push(item.input[field]);
        }
      }
      const rows = db.prepare(`SELECT id,story_id FROM tasks WHERE ${conditions.join(' AND ')}`).all(...values);
      assert.equal(rows.length > 0, item.hasTask, item.name);
      if (item.targetTaskId) {
        const target = rows.find((row) => row.id === item.targetTaskId);
        assert.ok(target, item.name);
        assert.equal(target.story_id, null, '初回から見える親なしの対象');
      }
      if (item.hasTask && Object.keys(item.input).length) assert.ok(rows.length < backlogTaskCount, '非該当の行もある');
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});
