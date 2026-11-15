// 組織のホームの「最近の更新」の面。作ったタスクとコメントが日付ごとの見出しの下に出て、行を押すと対象の詳細の引き出しが開くこと、
// 続きを「さらに読む」で足せること、空の案内と読み込みの失敗を確かめる。
// 返す行の範囲（所属、権限、消した行、カーソルの境目）は test/recent-activity.test.ts が確かめる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import type { Locator, Page } from '@playwright/test';
import { today } from '../src/shared/operations/organization/index.ts';
import { recentActivity, type RecentActivityEntry } from '../src/shared/operations/organization/recent-activity.ts';
import { taskTodayMark } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

function activityPane(page: Page): Locator {
  return page.locator('.dashboard-side .pane').filter({
    has: page.getByRole('heading', { level: 2, name: '最近の更新', exact: true }),
  });
}

const WORKSPACE = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };

// 画面が出す値だけを持つ行。時刻は 2026-10-20 の 14:00 JST から n 分前
function entry(n: number, overrides: Partial<RecentActivityEntry> = {}): RecentActivityEntry {
  const at = new Date(Date.UTC(2026, 9, 20, 5, 0) - n * 60_000).toISOString();
  return {
    id: `019a0000-0000-7000-9000-${String(n).padStart(12, '0')}`,
    created_at: at,
    actor: { id: '019a0000-0000-7000-8000-000000000201', name: 'ミナト' },
    workspace: WORKSPACE,
    target: {
      kind: 'task',
      id: `019a0000-0000-7000-8000-${String(800 + n).padStart(12, '0')}`,
      title: `更新の見本 ${n}`,
    },
    event: { kind: 'update', fields: ['title'] },
    ...overrides,
  };
}

test('作ったタスクとコメントが日付ごとの見出しの下に新しい順に出て、押すと詳細の引き出しが開く', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const title = `更新を追う ${suffix}`;
  const body = `手順の 2 番目から進めます ${suffix}`;
  await createWorkspace(page, `更新のワークスペース ${suffix}`);
  await addTaskRow(page, title);
  await page.locator('.entry', { hasText: title }).getByRole('link', { name: title }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('textbox', { name: 'コメントを書く' }).fill(body);
  await drawer.getByRole('button', { name: '送る' }).click();
  await expect(drawer.locator('.comment', { hasText: body })).toBeVisible();

  await page.goto('/aoba');
  const pane = activityPane(page);
  await expect(pane).toBeVisible();
  // 日付の見出し（ブラウザのタイムゾーン）の下に、新しい順に並ぶ。コメントが先で、作成が後
  await expect(pane.getByRole('heading', { level: 3 }).first()).toHaveText(/^\d{4}年\d{1,2}月\d{1,2}日（.）$/);
  const comment = pane.locator('.activity-row', { hasText: title }).filter({ hasText: 'コメントした' });
  const created = pane.locator('.activity-row', { hasText: title }).filter({ hasText: '作成した' });
  await expect(comment).toHaveCount(1);
  await expect(created).toHaveCount(1);
  const [commentBox, createdBox] = [(await comment.boundingBox())!, (await created.boundingBox())!];
  expect(commentBox.y).toBeLessThan(createdBox.y);
  // した人の名前、ワークスペース名、種類、時刻、コメントの本文の先頭
  await expect(comment).toContainText('ミナト');
  await expect(comment).toContainText(`更新のワークスペース ${suffix}`);
  await expect(comment.locator('.chip')).toHaveText('タスク');
  await expect(comment.locator('time')).toHaveText(/^\d{2}:\d{2}$/);
  await expect(comment.locator('.activity-body')).toHaveText(body);

  // 行を押すと、そのタスクの詳細が開く
  await comment.click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}\?task=[0-9a-f-]{36}$/);
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
});

test('更新が 20 件を超えると「さらに読む」で続きが足され、重なりも抜けも無く、読み切ると押せなくなる', async ({
  page,
}) => {
  const calls: (string | undefined)[] = [];
  await routeOperation(page, recentActivity, { slug: 'aoba' }, async (call) => {
    calls.push(call.input.before?.id);
    if (call.input.before === undefined) {
      const entries = Array.from({ length: 20 }, (_, index) => entry(index + 1));
      await call.fulfill({ entries, next: { created_at: entries[19]!.created_at, id: entries[19]!.id } });
      return;
    }
    await call.fulfill({ entries: Array.from({ length: 5 }, (_, index) => entry(index + 21)), next: null });
  });
  await page.goto('/aoba');

  const pane = activityPane(page);
  const rows = pane.locator('.activity-row');
  await expect(rows).toHaveCount(20);
  await expect(pane.getByRole('heading', { level: 3 })).toHaveText(['2026年10月20日（火）']);
  await expect(rows.first()).toContainText('更新の見本 1');
  await expect(rows.first().locator('.activity-text')).toHaveText('ミナトがタイトルを変更した');
  await expect(rows.first().locator('time')).toHaveText('13:59');

  await pane.getByRole('button', { name: 'さらに読む' }).click();
  await expect(rows).toHaveCount(25);
  expect(calls).toEqual([undefined, entry(20).id]);
  // 続きの最初の行へフォーカスが移り、押したボタンは消える
  await expect(rows.nth(20)).toBeFocused();
  await expect(pane.getByRole('button', { name: 'さらに読む' })).toHaveCount(0);
  const titles = await rows.locator('.activity-title').allTextContents();
  expect(new Set(titles).size).toBe(25);
  expect(titles[24]).toBe('更新の見本 25');
});

test('コメントの本文を切ったときは末尾に「…」を付け、ストーリーとエピックの行は種類の札と文を出す', async ({
  page,
}) => {
  await mockOperation(
    page,
    recentActivity,
    { slug: 'aoba' },
    {
      entries: [
        entry(1, { event: { kind: 'comment', body: 'あ'.repeat(200), truncated: true } }),
        entry(2, {
          target: { kind: 'story', id: '019a0000-0000-7000-8000-000000000901', title: '決済まわりを見直す' },
          event: { kind: 'complete' },
        }),
        entry(3, {
          target: { kind: 'epic', id: '019a0000-0000-7000-8000-000000000902', title: '会員ポイント制度を公開する' },
          event: { kind: 'reopen' },
          actor: null,
        }),
      ],
      next: null,
    },
  );
  await page.goto('/aoba');
  const pane = activityPane(page);
  await expect(pane.locator('.activity-body')).toHaveText(`${'あ'.repeat(200)}…`);
  const story = pane.locator('.activity-row', { hasText: '決済まわりを見直す' });
  await expect(story.locator('.chip')).toHaveText('ストーリー');
  await expect(story.locator('.activity-text')).toHaveText('ミナトが完了にした');
  await expect(story).toHaveAttribute('href', /\?story=019a0000-0000-7000-8000-000000000901$/);
  const epic = pane.locator('.activity-row', { hasText: '会員ポイント制度を公開する' });
  await expect(epic.locator('.chip')).toHaveText('エピック');
  await expect(epic.locator('.activity-text')).toHaveText('定期処理か運用者が完了を戻した');
  await expect(epic).toHaveAttribute('href', /\?epic_id=019a0000-0000-7000-8000-000000000902$/);
  await expect(pane.getByRole('button', { name: 'さらに読む' })).toHaveCount(0);
});

test('更新が 1 件も無いときは、面に空の案内を出す', async ({ page }) => {
  await mockOperation(page, recentActivity, { slug: 'aoba' }, { entries: [], next: null });
  await page.goto('/aoba');
  const pane = activityPane(page);
  await expect(pane.getByText('まだ更新はありません')).toBeVisible();
  await expect(pane.getByText('変更とコメントが、ここに新しい順に並びます。')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'さらに読む' })).toHaveCount(0);
});

test('最近の更新を読めなかったときは、面だけに失敗の案内を出し、「もう一度試す」で面だけを読み直せる', async ({
  page,
}) => {
  let failing = true;
  let calls = 0;
  await routeOperation(page, recentActivity, { slug: 'aoba' }, async (call) => {
    calls++;
    if (failing) await call.fail(500, 'internal');
    else await call.fulfill({ entries: [entry(1)], next: null });
  });
  await page.goto('/aoba');
  const pane = activityPane(page);
  await expect(pane.getByText('最近の更新を読み込めませんでした。')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '今日やること', exact: true })).toBeVisible();
  // 失敗の文だけが role="alert"。ボタンはその外にあり、状態は常設の role="status" が伝える
  await expect(pane.getByRole('alert')).toHaveText('最近の更新を読み込めませんでした。');
  const retry = pane.getByRole('button', { name: 'もう一度試す' });
  await expect(retry).not.toHaveAttribute('role', 'alert');
  // また失敗したら、状態に「まだ読み込めませんでした」を出し、ボタンは残る
  await retry.click();
  await expect(pane.getByRole('status')).toHaveText('まだ読み込めませんでした');
  expect(calls).toBe(2);
  // 読めれば、面だけが入れ替わる（ホームのほかの面は読み直さない）
  failing = false;
  await retry.click();
  await expect(pane.locator('.activity-row')).toHaveCount(1);
  await expect(pane.getByText('最近の更新を読み込めませんでした。')).toHaveCount(0);
  expect(calls).toBe(3);
});

test('読み込み中は面だけに骨組みと「読み込んでいます」を出し、ホームのほかの面は待たずに出る', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await routeOperation(page, recentActivity, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.fulfill({ entries: [entry(1)], next: null });
  });
  await page.goto('/aoba');
  const pane = activityPane(page);
  await expect(pane.locator('.skeleton .skeleton-line')).toHaveCount(3);
  await expect(pane.getByRole('status')).toHaveText('読み込んでいます');
  // ホームのほかの面は、最近の更新を待たずに出ている
  await expect(page.getByRole('heading', { level: 2, name: '今日やること', exact: true })).toBeVisible();
  release();
  await expect(pane.locator('.activity-row')).toHaveCount(1);
  await expect(pane.locator('.skeleton')).toHaveCount(0);
  await expect(pane.getByRole('status')).toHaveText('');
});

test('今日やることの操作でホームを読み直しても、最近の更新に足した続きは消えず、読み直さない', async ({ page }) => {
  let activityCalls = 0;
  await routeOperation(page, recentActivity, { slug: 'aoba' }, async (call) => {
    activityCalls++;
    if (call.input.before === undefined) {
      const entries = Array.from({ length: 20 }, (_, index) => entry(index + 1));
      await call.fulfill({ entries, next: { created_at: entries[19]!.created_at, id: entries[19]!.id } });
    } else {
      await call.fulfill({ entries: [entry(21), entry(22)], next: null });
    }
  });
  let todayCalls = 0;
  const task = {
    id: '019a0000-0000-7000-8000-000000000999',
    title: 'あとでやる',
    points: null,
    due_on: '2026-11-06',
    today_on: null as string | null,
    completed_at: null,
    workspace_id: WORKSPACE.id,
    workspace_name: WORKSPACE.name,
    today: '2026-11-04',
    week_start: 1,
    position: 'a0',
    carry_days: 0,
    sprint_active: false,
    is_today_completed: false,
    reopenable: false,
    assignee: null,
    delegatee: null,
    repository: null,
    sprint: null,
  };
  await routeOperation(page, today, { slug: 'aoba' }, (call) => {
    todayCalls++;
    return call.fulfill({ tasks: [task], sprint_goals: [] });
  });
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, (call) => {
    task.today_on = call.input.marked ? '2026-11-04' : null;
    return call.fulfill({ task_id: task.id, today_on: task.today_on });
  });
  await page.goto('/aoba');
  const pane = activityPane(page);
  await pane.getByRole('button', { name: 'さらに読む' }).click();
  await expect(pane.locator('.activity-row')).toHaveCount(22);
  expect(activityCalls).toBe(2);

  await page.getByRole('button', { name: '今日やる: あとでやる' }).click();
  await expect(page.getByRole('status').filter({ hasText: '今日やると決めました' })).toBeVisible();
  expect(todayCalls).toBe(2);
  await expect(pane.locator('.activity-row')).toHaveCount(22);
  expect(activityCalls).toBe(2);
});

test('続きの失敗の案内は、面を読み直すと消え、足した行が無かったときのフォーカスは最後の行へ戻る', async ({ page }) => {
  let mode: 'fail' | 'duplicate' = 'fail';
  let first = true;
  await routeOperation(page, recentActivity, { slug: 'aoba' }, async (call) => {
    if (call.input.before === undefined) {
      const entries = Array.from({ length: 20 }, (_, index) => entry(index + 1));
      await call.fulfill({
        entries,
        next: first ? { created_at: entries[19]!.created_at, id: entries[19]!.id } : null,
      });
      first = false;
    } else if (mode === 'fail') {
      await call.fail(500, 'internal');
    } else {
      // 先頭に足された行がずれて、読んだ行と重なった続き（足す行が 0 件）
      await call.fulfill({ entries: [entry(20)], next: null });
    }
  });
  await page.goto('/aoba');
  const pane = activityPane(page);
  const more = pane.getByRole('button', { name: 'さらに読む' });
  await more.click();
  await expect(pane.getByRole('alert')).toHaveText('続きを読み込めませんでした。もう一度試してください。');
  mode = 'duplicate';
  await more.click();
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await expect(pane.locator('.activity-row')).toHaveCount(20);
  await expect(more).toHaveCount(0);
  // 足す行が無かったときは、最後の行へフォーカスを戻す（押したボタンは消える）
  await expect(pane.locator('.activity-row').last()).toBeFocused();
});

test('「さらに読む」と「もう一度試す」は、狭い幅で 44px 以上で、長いワークスペース名で右の列からはみ出さない', async ({
  page,
}) => {
  const longName = '受託開発チームの第二期・保守と追加案件をまとめて見るための長い名前のワークスペース';
  await routeOperation(page, recentActivity, { slug: 'aoba' }, async (call) => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry(index + 1, { workspace: { id: WORKSPACE.id, name: longName } }),
    );
    await call.fulfill({ entries, next: { created_at: entries[19]!.created_at, id: entries[19]!.id } });
  });
  for (const width of [761, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/aoba');
    const pane = activityPane(page);
    await expect(pane.locator('.activity-row')).toHaveCount(20);
    const paneBox = (await pane.boundingBox())!;
    for (const tag of await pane.locator('.activity-meta .tag').all()) {
      const box = (await tag.boundingBox())!;
      expect(box.x + box.width, `幅 ${width}px`).toBeLessThanOrEqual(paneBox.x + paneBox.width);
    }
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(overflow.scroll, `幅 ${width}px`).toBeLessThanOrEqual(overflow.inner);
    if (width === 390) {
      expect((await pane.getByRole('button', { name: 'さらに読む' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await pane.locator('.activity-row').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await failOperation(page, recentActivity, { slug: 'aoba' }, 500, 'internal');
  await page.goto('/aoba');
  const retry = activityPane(page).getByRole('button', { name: 'もう一度試す' });
  await expect(retry).toBeVisible();
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('続きを読めなかったときは、読んだ分を残して知らせ、もう一度押せる', async ({ page }) => {
  let failing = true;
  await routeOperation(page, recentActivity, { slug: 'aoba' }, async (call) => {
    if (call.input.before === undefined) {
      const entries = Array.from({ length: 20 }, (_, index) => entry(index + 1));
      await call.fulfill({ entries, next: { created_at: entries[19]!.created_at, id: entries[19]!.id } });
    } else if (failing) {
      await call.fail(500, 'internal');
    } else {
      await call.fulfill({ entries: [entry(21)], next: null });
    }
  });
  await page.goto('/aoba');
  const pane = activityPane(page);
  await pane.getByRole('button', { name: 'さらに読む' }).click();
  await expect(pane.getByText('続きを読み込めませんでした。もう一度試してください。')).toBeVisible();
  await expect(pane.locator('.activity-row')).toHaveCount(20);
  failing = false;
  await pane.getByRole('button', { name: 'さらに読む' }).click();
  await expect(pane.locator('.activity-row')).toHaveCount(21);
  await expect(pane.getByText('続きを読み込めませんでした。')).toHaveCount(0);
});
