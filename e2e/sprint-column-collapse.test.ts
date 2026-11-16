import { sprintBoard, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, dragTo, signIn, waitForSettled, watchViolations } from './helpers.ts';
import { mockOperation, routeOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const TEAM = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test('列を畳んで再読み込みしても保存され、別のワークスペースには及ばない。390pxでも開閉する', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.goto(`${TEAM}/sprint`);
  const done = page.getByRole('region', { name: '完了', exact: true });
  const toggle = done.getByRole('button', { name: '完了の開閉' });
  await expect(done.locator('.card')).not.toHaveCount(0);
  const todoToggle = page.getByRole('button', { name: '未着手の開閉' });
  const draft = page.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true });
  await draft.fill('書きかけの札');
  await todoToggle.click();
  await expect(draft).toBeHidden();
  await page.keyboard.press('c');
  await expect(page.getByRole('textbox', { name: 'タスクを足す: 作業中', exact: true })).toBeFocused();
  await expect(page.locator('.draft-row input[aria-keyshortcuts]')).toHaveCount(1);
  await todoToggle.click();
  await expect(draft).toHaveValue('書きかけの札');
  await draft.fill('あ'.repeat(201));
  await draft.press('Enter');
  const draftError = page.getByRole('alert').filter({ hasText: 'タイトルは 200 字までです' });
  await expect(draftError).toBeVisible();
  await todoToggle.click();
  await expect(draftError).toBeHidden();
  await todoToggle.click();
  await expect(draftError).toBeVisible();
  await expect(draft).toHaveValue('あ'.repeat(201));
  await draft.fill('書きかけの札');
  const tally = await done.locator('.board-col-n').textContent();
  const points = await done.locator('.board-col-pts').textContent();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(done.locator('.card, .dod, .draft-row')).toHaveCount(0);
  await expect(done.locator('.board-col-n')).toHaveText(tally!);
  await expect(done.locator('.board-col-pts')).toHaveText(points!);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.scrollIntoViewIfNeeded();
  const box = await toggle.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(done.locator('.card')).not.toHaveCount(0);
  await toggle.click();
  // 同じ列IDの応答を新しいワークスペースにも返し、列IDだけで保存していないことを確かめる。
  await createWorkspace(page, '開閉を分ける見張り番');
  expect(new URL(page.url()).pathname).not.toContain('000000000401');
  const destination = `${new URL(page.url()).pathname.replace(/\/$/, '')}/sprint`;
  await page.goto(destination);
  await expect(page).toHaveURL(new RegExp(`${destination}$`));
  await expect(page.getByRole('heading', { level: 1, name: '第14回', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '完了の開閉' })).toHaveAttribute('aria-expanded', 'true');
  expect(await collect()).toEqual([]);
});

test('localStorageを拒否する端末でも列を開閉できる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.goto(`${TEAM}/sprint`);
  const toggle = page.getByRole('button', { name: '未着手の開閉' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('畳んだ列へドラッグすると末尾に入り、キー移動も隣の畳んだ列へ送る', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '列を畳む見張り番');
  await page.getByRole('link', { name: '計画', exact: true }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const create = page.getByRole('dialog', { name: 'スプリントを作る' });
  await create.getByLabel('名前（任意）').fill('列の開閉');
  await create.getByLabel('開始日').fill('2099-06-01');
  await create.getByRole('button', { name: '作る', exact: true }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: '始める: スプリント「列の開閉」' }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める', exact: true }).click();
  await expect(start).toBeHidden();
  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  const add = async (column: string, title: string) => {
    const input = page.getByRole('textbox', { name: `タスクを足す: ${column}`, exact: true });
    await input.fill(title);
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.locator('.card-title', { hasText: title })).toBeVisible();
  };
  await add('レビュー', '先の札');
  await add('未着手', '動かす札');
  await add('未着手', 'キーの札');
  const review = page.getByRole('region', { name: 'レビュー', exact: true });
  const toggle = review.getByRole('button', { name: 'レビューの開閉' });
  await toggle.click();
  const moved = page.waitForResponse((response) => response.url().includes('/task-column-move') && response.ok());
  await dragTo(
    page,
    page.getByRole('link', { name: '動かす札', exact: true }),
    review.locator('.board-col-head'),
    'middle',
  );
  await moved;
  await waitForSettled(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(review.locator('.card-title')).toHaveText(['先の札', '動かす札']);
  const working = page.getByRole('region', { name: '作業中', exact: true });
  const workingToggle = working.getByRole('button', { name: '作業中の開閉' });
  await workingToggle.click();
  const keyCard = page.locator('.card', { has: page.getByRole('link', { name: 'キーの札', exact: true }) });
  await keyCard.focus();
  const keyMoved = page.waitForResponse((response) => response.url().includes('/task-column-move') && response.ok());
  await page.keyboard.press('Alt+ArrowRight');
  await keyMoved;
  await waitForSettled(page);
  await expect(workingToggle).toBeFocused();
  await expect(working.locator('.card')).toHaveCount(0);
  await workingToggle.click();
  await expect(working.locator('.card-title')).toHaveText(['キーの札']);
  const doneToggle = page.getByRole('button', { name: '完了の開閉' });
  await doneToggle.click();
  await page.getByRole('button', { name: '完了にする: 動かす札', exact: true }).click();
  await expect(doneToggle).toBeFocused();
  await expect(doneToggle).toHaveAttribute('aria-expanded', 'false');
  await doneToggle.click();
  await toggle.click();
  await page.getByRole('button', { name: '完了を戻す: 動かす札', exact: true }).click();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.reload();
  await expect(review.locator('.card-title')).toHaveText(['先の札', '動かす札']);
});

for (const collapsed of [true, false]) {
  for (const succeeds of [true, false]) {
    test(`列が${collapsed ? '畳まれた' : '開いた'}ドラッグで、応答が${succeeds ? '成功' : '失敗'}のときだけ結果を通知する`, async ({
      page,
      context,
      baseURL,
    }) => {
      await signIn(context, baseURL, 'admin');
      await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sent = false;
      await routeOperation(page, taskColumnMove, { slug: 'aoba' }, async (call) => {
        sent = true;
        await gate;
        if (succeeds) await call.fulfill({ task_id: call.input.task_id, column_id: call.input.column_id });
        else await call.fail(500, 'internal');
      });
      await page.goto(`${TEAM}/sprint`);
      const title = SAMPLE_BOARD.columns[0].tasks[0].title;
      const target = page.getByRole('region', { name: 'レビュー', exact: true });
      if (collapsed) await target.getByRole('button', { name: 'レビューの開閉' }).click();
      const moved = page.locator('.toast').filter({ hasText: new RegExp(`${title}をレビューの`) });
      try {
        await dragTo(
          page,
          page.getByRole('link', { name: title, exact: true }),
          target.locator('.board-col-head'),
          'middle',
        );
        await expect.poll(() => sent).toBe(true);
        await expect(moved).toHaveCount(0);
        release();
        if (!succeeds) {
          await expect(page.locator('.toast', { hasText: '動かせませんでした。一覧を読み直します' })).toBeVisible();
          await expect(moved).toHaveCount(0);
        } else if (collapsed) {
          await expect(moved).toBeVisible();
        } else {
          await expect(page.getByRole('status').filter({ hasText: new RegExp(`${title}をレビューの`) })).toHaveCount(1);
          await expect(moved).toHaveCount(0);
        }
      } finally {
        release();
      }
    });
  }
}
