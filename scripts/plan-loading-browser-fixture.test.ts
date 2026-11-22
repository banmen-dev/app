import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { planBrowserFixtures, planBrowserFixtureSql } from './plan-loading-browser-fixture.ts';
import { fillSeedDates } from './seed-dates.ts';

test('一般メンバーの4計測条件を1つの使い捨てD1に入れられる', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    const at = new Date('2026-11-22T00:00:00Z');
    db.exec(fillSeedDates(readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8'), at));
    db.exec(planBrowserFixtureSql(at));
    assert.deepEqual(
      planBrowserFixtures.map(({ key }) => key),
      ['history', 'planned', 'empty', 'closed'],
    );
    for (const fixture of planBrowserFixtures) {
      const { key, slug, workspaceId, laneId, laneTitle, taskId, summaryEpicId, summaryEpicTitle, velocitySprintId } =
        fixture;
      const workspace = db
        .prepare(
          `SELECT o.slug, w.closed_at, m.role FROM workspaces w
          JOIN organizations o ON o.id = w.organization_id JOIN memberships m ON m.workspace_id = w.id
          WHERE w.id = ? AND m.user_id = '019a0000-0000-7000-8000-000000000302'`,
        )
        .get(workspaceId);
      assert.equal(workspace?.slug, slug);
      assert.equal(workspace?.closed_at, key === 'closed' ? at.toISOString() : null);
      assert.equal(workspace?.role, 'member');
      const counts = db
        .prepare(
          `SELECT
          (SELECT count(*) FROM tasks WHERE workspace_id = ?1) AS tasks,
          (SELECT count(*) FROM epics WHERE workspace_id = ?1) AS epics,
          (SELECT count(*) FROM sprints WHERE workspace_id = ?1 AND status = 'closed') AS closed,
          (SELECT count(*) FROM sprints WHERE workspace_id = ?1 AND status = 'active') AS active,
          (SELECT count(*) FROM sprints WHERE workspace_id = ?1 AND status = 'planned') AS planned`,
        )
        .get({ 1: workspaceId });
      const empty = key === 'empty';
      assert.equal(counts?.tasks, empty ? 0 : 5000);
      assert.equal(counts?.epics, empty ? 0 : 10);
      assert.equal(counts?.closed, empty ? 0 : 3);
      assert.equal(counts?.active, empty ? 0 : 1);
      assert.equal(counts?.planned, key === 'planned' ? 1 : 0);
      if (empty) continue;
      const lane = db
        .prepare(
          `SELECT s.name,
          (SELECT count(*) FROM tasks t WHERE t.sprint_id = s.id AND t.points IS NULL AND completed_at IS NULL) AS unestimated
          FROM sprints s WHERE s.workspace_id = ? AND s.id = ?`,
        )
        .get(workspaceId, laneId);
      assert.equal(lane?.name, laneTitle);
      assert.ok(Number(lane?.unestimated) > 0);
      assert.equal(
        db.prepare('SELECT sprint_id FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId)?.sprint_id,
        laneId,
      );
      assert.equal(
        db.prepare('SELECT title FROM epics WHERE id = ? AND workspace_id = ?').get(summaryEpicId, workspaceId)?.title,
        summaryEpicTitle,
      );
      assert.ok(
        Number(
          db
            .prepare('SELECT count(*) AS n FROM completions WHERE workspace_id = ? AND sprint_id = ?')
            .get(workspaceId, velocitySprintId)?.n,
        ) > 0,
      );
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
