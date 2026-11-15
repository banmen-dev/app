import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadingFixtureSql, loadingWorkspace } from './loading-fixture.ts';
import {
  emptyPlanSql,
  emptyPlanWorkspace,
  planConditions,
  planComparisonOptions,
  planTimingCell,
  readPlanComparison,
} from './plan-loading-comparison.ts';
import type { ReadResponse } from './loading-trial.ts';

test('計画比較の条件順と排他的オプションを確かめる', () => {
  assert.deepEqual(planComparisonOptions([]), { enabled: false, conditions: ['A', 'B', 'C'] });
  assert.deepEqual(planComparisonOptions(['--plan-compare']), { enabled: true, conditions: ['A', 'B', 'C'] });
  assert.deepEqual(planComparisonOptions(['--plan-compare', '--comparison-reverse']), {
    enabled: true,
    conditions: ['C', 'B', 'A'],
  });
  assert.deepEqual(planComparisonOptions(['--plan-compare']).conditions, ['A', 'B', 'C']);
  assert.deepEqual(planConditions, ['A', 'B', 'C'], '反転後も共有の条件配列を変えない');
  for (const flag of ['--layout-only', '--layout-before']) {
    assert.throws(() => planComparisonOptions(['--plan-compare', flag]), /併用できません/);
  }
  assert.throws(() => planComparisonOptions(['--comparison-reverse']), /必要です/);
});

test('集計列を取り違えずに nearest-rank の p50/p95 を出す', () => {
  const samples = [1, 2, 20].map((n) => ({ primary: n, ready: n + 100, total: n + 200 }));
  assert.equal(planTimingCell(samples, 'primary'), '2.00 / 20.00');
  assert.equal(planTimingCell(samples, 'ready'), '102.00 / 120.00');
  assert.equal(planTimingCell(samples, 'total'), '202.00 / 220.00');
  const unordered = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];
  const many = unordered.map((n) => ({ primary: n, ready: n + 100, total: n + 200 }));
  assert.equal(planTimingCell(many, 'primary'), '10.00 / 19.00');
  assert.equal(planTimingCell(many, 'ready'), '110.00 / 119.00');
  assert.equal(planTimingCell(many, 'total'), '210.00 / 219.00');
  assert.deepEqual(
    many.map((sample) => sample.primary),
    unordered,
    '集計で入力を並べ替えない',
  );
  assert.throws(() => planTimingCell([], 'ready'), /入力が不正/);
});

test('空の計画fixtureは既存の履歴を残し、同じ組織の管理者とメンバーだけを所属させる', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    db.exec(readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8'));
    db.exec(loadingFixtureSql(new Date('2026-11-15T00:00:00Z')));
    db.exec(emptyPlanSql);
    const memberships = (workspace: string) =>
      db.prepare('SELECT user_id, role FROM memberships WHERE workspace_id=? ORDER BY user_id').all(workspace);
    assert.deepEqual(memberships(emptyPlanWorkspace), memberships(loadingWorkspace));
    assert.equal(memberships(emptyPlanWorkspace).length, 2);
    for (const table of ['sprints', 'tasks', 'epics']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=?`).get(emptyPlanWorkspace)?.n, 0);
      assert.ok(
        Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=?`).get(loadingWorkspace)?.n) > 0,
      );
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

for (const condition of planConditions) {
  for (const reverse of [false, true]) {
    test(`${condition} 逆順=${reverse}: 発行と返却モデルを分け、従を回収する`, async () => {
      const calls: string[] = [];
      const validated: string[] = [];
      const pending = new Map<string, (response: ReadResponse) => void>();
      let completed = false;
      const trial = readPlanComparison(
        condition,
        'workspace',
        reverse,
        (op) => {
          assert.deepEqual(op.input, { workspace_id: 'workspace' });
          calls.push(op.name);
          return new Promise((resolve) => pending.set(op.name, resolve));
        },
        () => 100,
      ).then((result) => {
        completed = true;
        return result;
      });
      assert.deepEqual(
        calls,
        condition === 'A'
          ? ['sprint-list']
          : reverse
            ? ['plan-summary', 'sprint-list']
            : ['sprint-list', 'plan-summary'],
      );
      const finish = (name: string, finishedAt: number) =>
        pending.get(name)!({
          ms: 10,
          finishedAt,
          secondary: name === 'plan-summary',
          body: name,
          validate: () => {
            validated.push(name);
          },
        });
      finish('sprint-list', 120);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (condition !== 'A') {
        assert.equal(completed, false, 'C でも全応答回収前に試行を終えない');
        assert.deepEqual(validated, []);
        finish('plan-summary', 150);
      }
      assert.deepEqual(await trial, {
        primary: 20,
        ready: condition === 'B' ? 50 : 20,
        total: condition === 'A' ? 20 : 50,
      });
      assert.equal(validated.length, condition === 'A' ? 1 : 2);
    });
  }
}

test('従が先に終わる場合は B/C の返却モデルに差を作らない', async () => {
  for (const condition of ['B', 'C'] as const) {
    const result = await readPlanComparison(
      condition,
      'workspace',
      true,
      async (op) => ({
        ms: 10,
        finishedAt: op.secondary ? 110 : 130,
        secondary: op.secondary,
        body: {},
        validate: () => {},
      }),
      () => 100,
    );
    assert.deepEqual(result, { primary: 30, ready: 30, total: 30 });
  }
});

test('従の不正応答を C でも拒否する', async () => {
  await assert.rejects(
    readPlanComparison(
      'C',
      'workspace',
      false,
      async (op) => ({
        ms: 10,
        finishedAt: 110,
        secondary: op.secondary,
        body: {},
        validate: () => {
          if (op.secondary) throw new Error('invalid summary');
        },
      }),
      () => 100,
    ),
    /invalid summary/,
  );
});
