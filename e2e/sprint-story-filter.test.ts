import { expect, test } from './fixtures.ts';
import { signIn, dragTo, waitForSettled } from './helpers.ts';
import { mockOperation, routeOperation } from './operations.ts';
import { sprintBoard, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { taskCreate } from '../src/shared/operations/task/index.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const PATH = '/aoba/w/019a0000-0000-7000-8000-000000000401/sprint';
const STORY = SAMPLE_BOARD.columns[0]!.tasks[0]!.story!;
function sample() {
  const board = structuredClone(SAMPLE_BOARD);
  board.columns[1]!.tasks[0]!.story = STORY;
  board.columns[3]!.tasks[0]!.story = STORY;
  return board;
}

test('親名のポインタとフォーカスで列をまたいで強調し、URLで絞り込み・再読込・解除する', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, sample());
  await page.goto(PATH);
  const parents = page.getByRole('button', { name: `ストーリーで絞り込む: ${STORY.title}`, exact: true });
  await parents.first().hover();
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(3);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(1);
  await page.getByRole('heading', { level: 1 }).hover();
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
  await parents.first().focus();
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(3);
  const totals = await page.locator('.page-head .tally dd').allTextContents();
  await parents.first().click();
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
  await expect(page.locator('.board-col').first().locator('.board-col-n')).toHaveText('1');
  await expect(page.locator('.board-col').first().locator('.board-col-pts')).toHaveText('5 pt');
  // 見出しは絞る前の全体のまま（5+3+2 pt）
  await expect(page.locator('.page-head .tally dd')).toHaveText(totals);
  await page.reload();
  await expect(page.locator('.card')).toHaveCount(3);
  await page.getByRole('button', { name: '絞り込みを外す', exact: true }).click();
  await expect(page).not.toHaveURL(/story=/);
  await expect(page.locator('.card')).toHaveCount(4);
  await expect(parents.first()).toBeFocused();
});

test('絞った状態の作成はそのストーリーを親にし、その場に残る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = sample();
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => call.fulfill(board));
  await routeOperation(page, taskCreate, { slug: 'aoba' }, async (call) => {
    expect(call.input.story_id).toBe(STORY.id);
    const task = {
      ...board.columns[0]!.tasks[0]!,
      id: '019a0000-0000-7000-8000-00000000f299',
      title: call.input.title,
      points: null,
    };
    board.columns[0]!.tasks.push(task);
    await call.fulfill({
      task: {
        id: task.id,
        title: task.title,
        points: null,
        due_on: null,
        assignee: null,
        delegatee: null,
        category: null,
        repository: null,
        sprint: null,
        can_delete: false,
      },
    });
  });
  await page.goto(`${PATH}?story=${STORY.id}`);
  const input = page.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true });
  await input.fill('絞り込みで追加する札');
  await input.press('Enter');
  await expect(page.locator('.card-title', { hasText: '絞り込みで追加する札' })).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(4);
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
});

test('完了したストーリーへの作成の409は既存の理由を出す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, sample());
  await routeOperation(page, taskCreate, { slug: 'aoba' }, (call) => call.fail(409, 'conflict'));
  await page.goto(`${PATH}?story=${STORY.id}`);
  const input = page.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true });
  await input.fill('断られる札');
  await input.press('Enter');
  await expect(
    page.getByText('このストーリーは完了したので、タスクを足せません。一覧を読み直します', { exact: true }),
  ).toBeVisible();
});

test('絞ったカードをキーとドラッグで移動し、隠れたカードを表示しない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = sample();
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, board);
  const inputs: { task_id: string; column_id: string; after_task_id?: string | null }[] = [];
  await routeOperation(page, taskColumnMove, { slug: 'aoba' }, async (call) => {
    inputs.push(call.input);
    await call.fulfill({ task_id: call.input.task_id, column_id: call.input.column_id });
  });
  await page.goto(`${PATH}?story=${STORY.id}`);
  const first = page.locator(`[data-card-id="${board.columns[0]!.tasks[0]!.id}"]`);
  await first.focus();
  await first.press('Alt+ArrowRight');
  await expect(page.locator('.board-col').nth(1).locator('.card')).toHaveCount(2);
  await expect.poll(() => inputs.length).toBe(1);
  expect(inputs[0]!.column_id).toBe(board.columns[1]!.id);
  await waitForSettled(page);
  await dragTo(page, first, page.locator('.board-col').nth(2).locator('.board-col-head'), 'middle');
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[1]!.column_id).toBe(board.columns[2]!.id);
  await expect(page.locator('.card')).toHaveCount(3);
});

test('無効な親IDはURLから解除して全件に戻し、狭い幅と動きを減らす設定でも親名を押せる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, sample());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${PATH}?story=missing`);
  await expect(page).not.toHaveURL(/story=/);
  await expect(page.locator('.card')).toHaveCount(4);
  const parent = page.locator('.card-parent').first();
  await expect(parent).toHaveCSS('min-height', '44px');
  await parent.click();
  await expect(page.locator('.story-filter-band')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(3);
});
