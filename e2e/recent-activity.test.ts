// 組織のホームの「最近の更新」の面。作ったタスクとコメントが日付ごとの見出しの下に出て、行を押すと対象の詳細の引き出しが開くこと、
// 続きを「さらに読む」で足せること、空の案内と読み込みの失敗を確かめる。
// 返す行の範囲（所属、権限、消した行、カーソルの境目）は test/recent-activity.test.ts が確かめる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import type { Locator, Page } from '@playwright/test';
import { recentActivity, type RecentActivityEntry } from '../src/shared/operations/organization/recent-activity.ts';
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

test('最近の更新を読めなかったときは、面だけに失敗の案内を出し、ホームのほかの面は出したままにする', async ({
  page,
}) => {
  await failOperation(page, recentActivity, { slug: 'aoba' }, 500, 'internal');
  await page.goto('/aoba');
  const pane = activityPane(page);
  await expect(pane.getByText('最近の更新を読み込めませんでした。')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '今日やること', exact: true })).toBeVisible();
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
