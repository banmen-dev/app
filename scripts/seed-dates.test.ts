// seed の日付の印（scripts/seed-dates.ts）を、流した日を1年分ずらして埋め、今日との関係が変わらないことを確かめる
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { todayIn } from '../src/shared/clock.ts';
import { addDays } from '../src/shared/due.ts';
import { fillSeedDates, seedBase, seedWeekDate, SEED_TIMEZONE } from './seed-dates.ts';

const data = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');

const CLIENT_TEAM = '019a0000-0000-7000-8000-000000000401';
const ACTIVE_SPRINT = '019a0000-0000-7000-8000-000000001003';

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  return db;
}

type Sprint = {
  id: string;
  workspace_id: string;
  start_on: string;
  end_on: string;
  status: string;
  started_at: string | null;
  closed_at: string | null;
};

function tokyoDate(at: string): string {
  return todayIn(SEED_TIMEZONE, new Date(at));
}

// 流した日時 now で seed を入れ、関係を確かめる。入れた行は巻き戻す
function checkSeededAt(db: DatabaseSync, now: Date): void {
  const label = now.toISOString();
  const today = todayIn(SEED_TIMEZONE, now);
  db.exec('BEGIN');
  try {
    db.exec(fillSeedDates(data, now));
    const sprints = db.prepare('SELECT * FROM sprints ORDER BY workspace_id, start_on').all() as Sprint[];
    for (const sprint of sprints) {
      if (sprint.status === 'closed') {
        assert.ok(sprint.end_on < today, `${label}: 終了したスプリント ${sprint.id} は過去`);
        assert.ok(tokyoDate(sprint.closed_at!) > sprint.end_on, `${label}: ${sprint.id} は最終日の後に終えた`);
      } else if (sprint.status === 'active') {
        assert.ok(sprint.start_on <= today && today < sprint.end_on, `${label}: 進行中は今日を含み最終日より前`);
        assert.ok(tokyoDate(sprint.started_at!) >= sprint.start_on, `${label}: 始めた日時は開始日から`);
      } else {
        assert.ok(sprint.start_on > today, `${label}: 先のスプリント ${sprint.id} は今日より後`);
      }
    }
    assert.ok(sprints.some((s) => s.id === ACTIVE_SPRINT && s.status === 'active'));

    // 受託開発チームのスプリントは期間が重ならない
    const team = sprints.filter((s) => s.workspace_id === CLIENT_TEAM);
    for (let i = 1; i < team.length; i++) {
      assert.ok(team[i - 1]!.end_on < team[i]!.start_on, `${label}: ${team[i]!.id} が前と重なる`);
    }

    // ベロシティの元: 終了したスプリントの完了のポイントが、古い順に 6、13、8、7
    const velocity = db
      .prepare(
        `SELECT s.name, sum(c.points) AS points FROM sprints s JOIN completions c ON c.sprint_id = s.id
         WHERE s.workspace_id = ? AND s.status = 'closed' GROUP BY s.id ORDER BY s.start_on`,
      )
      .all(CLIENT_TEAM) as { points: number }[];
    assert.deepEqual(
      velocity.map((row) => row.points),
      [6, 13, 8, 7],
      label,
    );

    // 完了の日時は、入っていたスプリントの期間の中
    const completions = db
      .prepare(`SELECT c.completed_at, s.start_on, s.end_on FROM completions c JOIN sprints s ON s.id = c.sprint_id`)
      .all() as { completed_at: string; start_on: string; end_on: string }[];
    for (const row of completions) {
      const on = tokyoDate(row.completed_at);
      assert.ok(row.start_on <= on && on <= row.end_on, `${label}: 完了 ${row.completed_at} がスプリントの外`);
    }

    // 動かした日時はどれも流した日時より後にならない
    const times = db
      .prepare(
        `SELECT started_at AS at FROM sprints UNION ALL SELECT closed_at FROM sprints
         UNION ALL SELECT added_at FROM sprint_entries UNION ALL SELECT ended_at FROM sprint_entries
         UNION ALL SELECT completed_at FROM completions UNION ALL SELECT completed_at FROM tasks`,
      )
      .all() as { at: string | null }[];
    for (const { at } of times) {
      if (at !== null) assert.ok(at <= label, `${label}: ${at} が未来`);
    }

    // 受託開発チームの未完了のタスクに、期日切れと先の期日がある
    const dues = (
      db
        .prepare(`SELECT due_on FROM tasks WHERE workspace_id = ? AND completed_at IS NULL AND due_on IS NOT NULL`)
        .all(CLIENT_TEAM) as { due_on: string }[]
    ).map((row) => row.due_on);
    assert.ok(
      dues.some((due) => due < today),
      `${label}: 期日切れのタスクがある`,
    );
    assert.ok(
      dues.some((due) => due > today),
      `${label}: 先の期日のタスクがある`,
    );

    // 休日は、e2e/holiday.test.ts が足す W+101 と W+107 より前（重ならず、一覧の先頭が seed の休日のまま）
    const holidays = (db.prepare('SELECT holiday_on FROM organization_holidays').all() as { holiday_on: string }[]).map(
      (row) => row.holiday_on,
    );
    const firstAdded = seedWeekDate(seedBase(now), 101);
    assert.ok(
      holidays.every((holiday) => holiday < firstAdded),
      label,
    );

    // 同意の版は動かさない
    const consents = db
      .prepare('SELECT DISTINCT terms_version, privacy_version FROM account_consents')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(consents, [{ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION }], label);
  } finally {
    db.exec('ROLLBACK');
  }
}

describe('fillSeedDates', () => {
  test('印を、週の月曜（W）と流した日（T）からの日付と、流した日時を上限にした日時で埋める', () => {
    // 2026-11-17（火曜）の 10:00（Asia/Tokyo）
    const now = new Date('2026-11-17T01:00:00.000Z');
    assert.equal(
      fillSeedDates('{{W+0}}, {{W-14}}, {{T+3}}, {{T-1}}, {{W-3 06:20}}, {{W+1 00:30}}, {{W+1 02:00}}', now),
      "'2026-11-16', '2026-11-02', '2026-11-20', '2026-11-16', '2026-11-13T06:20:00.000Z', '2026-11-17T00:30:00.000Z', '2026-11-17T01:00:00.000Z'",
    );
  });

  test('週の月曜と流した日は Asia/Tokyo の日付で決める（UTC では前の日曜の夜でも、東京の月曜なら月曜が基準）', () => {
    const base = seedBase(new Date('2026-11-15T15:30:00.000Z'));
    assert.deepEqual([base.week, base.today], ['2026-11-16', '2026-11-16']);
  });

  test('読めない印は止める（埋め忘れた印を SQL に流さない）', () => {
    assert.throws(
      () => fillSeedDates("VALUES ({{W+1}}, {{X+1}}, 'a')", new Date()),
      /seed の日付の印を読めない: \{\{X\+1\}\}/,
    );
    assert.throws(() => fillSeedDates('{{W+1 9:00}}', new Date()), /読めない/);
  });

  test('data.sql の印は、どれも読める形', () => {
    assert.doesNotThrow(() => fillSeedDates(data, new Date()));
    assert.ok(/\{\{W[+-]\d+\}\}/.test(data), '印のある data.sql を読んでいる');
  });
});

describe('seed を流した日を1年分ずらす', () => {
  test('どの日に流しても、スプリントと期日と休日の関係が変わらない', () => {
    const db = migratedDatabase();
    try {
      // 2026-11-17 から 366 日。1日に2回、Asia/Tokyo の日付の始まり直後（月曜なら進行中のスプリントを始める前）と終わり直前に流す
      for (let day = 0; day < 366; day++) {
        const date = addDays('2026-11-17', day);
        checkSeededAt(db, new Date(`${addDays(date, -1)}T15:00:30.000Z`));
        checkSeededAt(db, new Date(`${date}T14:59:30.000Z`));
      }
    } finally {
      db.close();
    }
  });
});
