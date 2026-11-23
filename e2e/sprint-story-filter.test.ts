import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  signIn,
  dragTo,
  waitForSettled,
  applyTheme,
  A11Y_THEMES,
  findA11yViolations,
  expectFocusReturned,
  openSprintPopover,
  sprintButton,
} from './helpers.ts';
import { storyGet } from '../src/shared/operations/story/story-get.ts';
import { mockOperation, routeOperation } from './operations.ts';
import { sprintBoard, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { taskComplete, taskCreate, taskDelete, taskReopen } from '../src/shared/operations/task/index.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const PATH = '/aoba/w/019a0000-0000-7000-8000-000000000401/board';
const STORY = SAMPLE_BOARD.columns[0]!.tasks[0]!.story!;
// スプリントの全体の進み具合（絞り込みに依らない）。道具の帯のスプリントのボタンの小窓に出す（#1498）
async function expectSprintTotals(page: Page, done = '完了 2 / 10 pt（20%）'): Promise<void> {
  const popover = await openSprintPopover(page);
  await expect(popover.locator('.progress-bar')).toHaveAccessibleName(`${done}、経過 8 / 14 日（57%）`);
  await expect(popover.locator('.progress-remaining')).toHaveText('残り 7 日');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
}
// ?story= を誤って詳細として扱うと、APIの応答順によらずこの検査で落とす。
test.beforeEach(async ({ page }) => {
  await routeOperation(page, storyGet, { slug: 'aoba' }, async (call) => {
    if (new URL(page.url()).pathname.endsWith('/board')) {
      expect.soft(false, 'スプリントのstory絞り込みでstory-getを呼んではいけない').toBe(true);
      await call.fail(500, 'internal');
    } else await call.passThrough();
  });
});
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
  await expectSprintTotals(page);
  await parents.first().click();
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
  await waitForSettled(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: `ストーリー「${STORY.title}」で絞り込みました` }),
  ).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
  await expect(page.locator('.board-col').first().locator('.board-col-n')).toHaveText('1');
  await expect(page.locator('.board-col').first().locator('.board-col-pts')).toHaveText('5 pt');
  // 見出しは絞る前の全体のまま（5+3+2 pt）
  await expectSprintTotals(page);
  // スプリントの小窓の編集と開閉を使っても、storyの絞り込みは維持する。
  await (await openSprintPopover(page)).getByRole('button', { name: 'スプリントを編集: 第14回', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'スプリントを直す', exact: true });
  await expect(edit).toBeVisible();
  await edit.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(edit).toBeHidden();
  await expectFocusReturned(page, sprintButton(page));
  await openSprintPopover(page);
  await page.keyboard.press('Escape');
  await expectFocusReturned(page, sprintButton(page));
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
  await page.reload();
  await expect(page.locator('.card')).toHaveCount(3);
  await page.getByRole('button', { name: '絞り込みを外す', exact: true }).click();
  await expect(page).not.toHaveURL(/story=/);
  await expect(page.locator('.card')).toHaveCount(4);
  await expect(parents.first()).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーの絞り込みを外しました' })).toBeVisible();
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
  // つかむのは題のリンク（カードの真ん中は、下の段の親のストーリーやチップのボタンに当たりうる。ボタンからは動き出さない）
  await dragTo(
    page,
    first.locator('.card-title'),
    page.locator('.board-col').nth(2).locator('.board-col-head'),
    'middle',
  );
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[1]!.column_id).toBe(board.columns[2]!.id);
  await expect(page.locator('.card')).toHaveCount(3);
});

test('絞り込み中も完了の丸を出さず、最後の未完了列からキーで完了にする', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = sample();
  const task = board.columns[0]!.tasks.shift()!;
  board.columns[2]!.tasks.push(task);
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => call.fulfill(board));
  let completed = 0;
  await routeOperation(page, taskComplete, { slug: 'aoba' }, async (call) => {
    expect(call.input.task_id).toBe(task.id);
    completed++;
    board.columns[2]!.tasks = [];
    task.completed_at = '2026-10-20T00:00:00.000Z';
    board.columns[3]!.tasks.push(task);
    await call.fulfill({ task_id: task.id, completed_at: task.completed_at, left_sprint: false });
  });
  await page.goto(`${PATH}?story=${STORY.id}`);
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.card .done-btn')).toHaveCount(0);
  await expectSprintTotals(page, '完了 2 / 10 pt（20%）');
  await page.locator(`[data-card-id="${task.id}"]`).press('Alt+ArrowRight');
  await expect.poll(() => completed).toBe(1);
  await expect(page.locator('.board-col.is-done').locator('.card')).toHaveCount(2);
  await expectSprintTotals(page, '完了 7 / 10 pt（70%）');
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
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
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '絞り込み対象のストーリーが現在のボードにないため、絞り込みを外しました' }),
  ).toBeVisible();
  const parent = page.locator('.card-parent').first();
  await expect(parent).toHaveCSS('min-height', '44px');
  await parent.click();
  await expect(page.locator('.story-filter-band')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(3);
  const clear = page.getByRole('button', { name: '絞り込みを外す', exact: true });
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});

test('絞り込み中にタスク詳細を開閉してもstoryを保持し、不要な詳細を開かない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = sample();
  board.columns[0]!.tasks[0]!.id = '019a0000-0000-7000-8000-000000000801';
  board.columns[0]!.tasks[0]!.title = 'ポイント付与のバッチを作る';
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, board);
  await page.goto(`${PATH}?story=${STORY.id}`);
  await waitForSettled(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.card-title').first().click();
  const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る', exact: true });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/task=019a0000-0000-7000-8000-000000000801/);
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
  await drawer.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/task=/);
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
});

test('バックログでは同じstoryクエリで従来の詳細を開き、閉じられる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto(PATH.replace('/board', ''));
  await page.getByRole('link', { name: STORY.title, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: STORY.title, exact: true });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/story=/);
  await drawer.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/story=/);
});

test('親付き作成の404は親も含む理由を出し、親を引き継ぐ案内を入力のそばに置く', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, sample());
  await routeOperation(page, taskCreate, { slug: 'aoba' }, (call) => call.fail(404, 'not_found'));
  await page.goto(`${PATH}?story=${STORY.id}`);
  const column = page.locator('.board-col').first();
  await expect(column).toContainText('絞り込んだストーリーの下に追加します');
  const input = column.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true });
  await input.fill('親が消えた札');
  await input.press('Enter');
  await expect(column).toContainText(
    'このストーリーかスプリントか列が見つかりません。タスクは作られていません。一覧を読み直します',
  );
});

test('絞り込みと列の畳み・保存・下書き・移動先フォーカスが共存する', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = sample();
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, board);
  await routeOperation(page, taskColumnMove, { slug: 'aoba' }, (call) =>
    call.fulfill({ task_id: call.input.task_id, column_id: call.input.column_id }),
  );
  await page.goto(`${PATH}?story=${STORY.id}`);
  await expectSprintTotals(page);
  const todo = page.locator('.board-col').first();
  const draft = todo.getByRole('textbox');
  await expect(draft).toHaveAccessibleDescription('絞り込んだストーリーの下に追加します');
  await draft.fill('畳んでも残る下書き');
  const todoToggle = todo.getByRole('button', { name: '未着手の開閉', exact: true });
  await todoToggle.click();
  await expect(todo.locator('.card')).toHaveCount(0);
  await expect(todo.locator('.board-col-n')).toHaveText('1');
  await expect(todo.locator('.board-col-pts')).toHaveText('5 pt');
  await expect(draft).toBeHidden();
  await page.keyboard.press('c');
  await expect(page.getByRole('textbox', { name: 'タスクを足す: 作業中', exact: true })).toBeFocused();
  await todoToggle.click();
  await expect(draft).toHaveValue('畳んでも残る下書き');
  const workingToggle = page.getByRole('button', { name: '作業中の開閉', exact: true });
  await workingToggle.click();
  await todo.locator('.card').press('Alt+ArrowRight');
  await expect(workingToggle).toBeFocused();
  await expect(page.locator('.board-col').nth(1).locator('.board-col-n')).toHaveText('2');
  await expect(page.locator('.board-col').nth(1).locator('.card')).toHaveCount(0);
  await expectSprintTotals(page);
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
  await page.reload();
  await expect(workingToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
  await todoToggle.click();
  await page.getByRole('button', { name: '完了の開閉', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(0);
  await page.getByRole('button', { name: '絞り込みを外す', exact: true }).click();
  await expect(page).not.toHaveURL(/story=/);
  await expect(todoToggle).toBeFocused();
  await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
});

test('カードのどこに乗っても同じストーリーを強調し、隙間では保ち、見出し・親のないカード・盤の外では外す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, sample());
  await page.goto(PATH);
  const highlighted = page.locator('.card.is-story-highlighted');
  const dimmed = page.locator('.card.is-story-dimmed');
  const cardOf = (title: string) =>
    page.locator('.card').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  const storyCard = cardOf('管理画面にポイント履歴の一覧を出す');
  const plainCard = cardOf('障害時の連絡手順を書く');
  await storyCard.locator('.card-foot').hover();
  await expect(highlighted).toHaveCount(3);
  await expect(dimmed).toHaveCount(1);
  // 同じ列のカードの間の隙間（列の地）では、直前のカードの強調を保つ
  const upper = (await storyCard.boundingBox())!;
  const lower = (await plainCard.boundingBox())!;
  const gap = { x: upper.x + upper.width / 2, y: (upper.y + upper.height + lower.y) / 2 };
  await page.mouse.move(gap.x, gap.y);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('board-col'), gap)).toBe(
    true,
  );
  await expect(highlighted).toHaveCount(3);
  // 別の列の同じストーリーのカードへ直に移っても強調したまま
  await cardOf('付与の履歴を返す API を作る').locator('.card-foot').hover();
  await expect(highlighted).toHaveCount(3);
  await plainCard.locator('.card-foot').hover();
  await expect(highlighted).toHaveCount(0);
  await expect(dimmed).toHaveCount(0);
  await storyCard.locator('.card-title').hover();
  await expect(highlighted).toHaveCount(3);
  await page.locator('.board-col-head').first().hover();
  await expect(highlighted).toHaveCount(0);
  // ポインタはフォーカスより先。親のないカードに乗れば消し、盤を出たらフォーカスの強調に戻す
  await page
    .getByRole('button', { name: `ストーリーで絞り込む: ${STORY.title}`, exact: true })
    .first()
    .focus();
  await expect(highlighted).toHaveCount(3);
  await plainCard.locator('.card-foot').hover();
  await expect(highlighted).toHaveCount(0);
  await page.getByRole('heading', { level: 1 }).hover();
  await expect(highlighted).toHaveCount(3);
  // ポインタを盤に置いたまま、キーボードで親名へ移ったら、フォーカスしたストーリーを先にする
  await plainCard.locator('.card-foot').hover();
  await expect(highlighted).toHaveCount(0);
  await page
    .getByRole('button', { name: `ストーリーで絞り込む: ${STORY.title}`, exact: true })
    .nth(1)
    .focus();
  await expect(highlighted).toHaveCount(3);
});

test('ポインタが乗ったまま消したカードの強調を残さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = sample();
  const task = board.columns[0]!.tasks[0]!;
  task.can_delete = true;
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => call.fulfill(board));
  await routeOperation(page, taskDelete, { slug: 'aoba' }, (call) => {
    board.columns[0]!.tasks = board.columns[0]!.tasks.filter((item) => item.id !== task.id);
    return call.fulfill({ task_id: task.id });
  });
  await page.goto(PATH);
  const card = page.locator(`[data-card-id="${task.id}"]`);
  await card.locator('.card-foot').hover();
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(3);
  await card.locator('.row-menu-btn').click();
  await card.getByRole('menuitem', { name: 'このタスクを削除する', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(0);
});

test('隙間で保った強調のストーリーが盤から消えたら、残ったカードを暗くしたままにしない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const board = structuredClone(SAMPLE_BOARD);
  const task = board.columns[0]!.tasks[0]!;
  task.can_delete = true;
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => call.fulfill(board));
  await routeOperation(page, taskDelete, { slug: 'aoba' }, (call) => {
    board.columns[0]!.tasks = board.columns[0]!.tasks.filter((item) => item.id !== task.id);
    return call.fulfill({ task_id: task.id });
  });
  await page.goto(PATH);
  const card = page.locator(`[data-card-id="${task.id}"]`);
  await card.locator('.card-foot').hover();
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(1);
  // 列と列の間（盤の地）へ動かす。列の高さが変わっても、ポインタの下は盤の地のまま
  const left = (await page.locator('.board-col').nth(0).boundingBox())!;
  const right = (await page.locator('.board-col').nth(1).boundingBox())!;
  const box = (await card.boundingBox())!;
  const point = { x: (left.x + left.width + right.x) / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('board'), point)).toBe(
    true,
  );
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(1);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(3);
  // ポインタを動かさずに、キーボードで「⋯」から削除する
  await card.locator('.row-menu-btn').press('Enter');
  await card.getByRole('menuitem', { name: 'このタスクを削除する', exact: true }).press('Enter');
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(0);
});

test('タッチで押している間は、同じストーリーの強調で他のカードを暗くしない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, sample());
  await page.goto(PATH);
  const card = page.locator(`[data-card-id="${SAMPLE_BOARD.columns[0]!.tasks[0]!.id}"]`);
  // タップは指を離すと pointerleave まで進むので、押した直後（pointerenter）の状態を種類ごとに作って比べる
  await card.dispatchEvent('pointerenter', { pointerType: 'touch' });
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(0);
  await card.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(3);
  // タッチに持ち替えてカードに触れたら、保っていたマウスの強調も外す
  await card.locator('.card-foot').dispatchEvent('pointerover', { pointerType: 'touch' });
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(0);
  // 見出しに触れたときも外す
  await card.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(3);
  await page.locator('.board-col-head').first().dispatchEvent('pointerover', { pointerType: 'touch' });
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
});

test('隙間で保った強調のストーリーのカードを列ごと畳んだら、残ったカードを暗くしたままにしない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.goto(PATH);
  const card = page.locator(`[data-card-id="${SAMPLE_BOARD.columns[0]!.tasks[0]!.id}"]`);
  await card.locator('.card-foot').hover();
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(1);
  const left = (await page.locator('.board-col').nth(0).boundingBox())!;
  const right = (await page.locator('.board-col').nth(1).boundingBox())!;
  const box = (await card.boundingBox())!;
  await page.mouse.move((left.x + left.width + right.x) / 2, box.y + box.height / 2);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(3);
  // ポインタを動かさずに、キーボードでそのカードの列を畳む
  const toggle = page.getByRole('button', { name: '未着手の開閉', exact: true });
  await toggle.press('Enter');
  await expect(card).toHaveCount(0);
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(0);
  // 開き直してカードが戻っても、捨てた強調を出し直さない
  await toggle.press('Enter');
  await expect(card).toHaveCount(1);
  await expect(page.locator('.card.is-story-highlighted')).toHaveCount(0);
  await expect(page.locator('.card.is-story-dimmed')).toHaveCount(0);
});

test('最後の対象カードを削除したら中立の案内で絞り込みを解除する', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = structuredClone(SAMPLE_BOARD);
  const task = board.columns[0]!.tasks[0]!;
  task.can_delete = true;
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => call.fulfill(board));
  await routeOperation(page, taskDelete, { slug: 'aoba' }, (call) => {
    expect(call.input.task_id).toBe(task.id);
    board.columns[0]!.tasks = board.columns[0]!.tasks.filter((item) => item.id !== task.id);
    return call.fulfill({ task_id: task.id });
  });
  await page.goto(`${PATH}?story=${STORY.id}`);
  await expect(page.locator('.card')).toHaveCount(1);
  await page.locator('.card .row-menu-btn').click();
  await page.getByRole('menuitem', { name: 'このタスクを削除する', exact: true }).click();
  await expect(page).not.toHaveURL(/story=/);
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '絞り込み対象のストーリーが現在のボードにないため、絞り込みを外しました' }),
  ).toBeVisible();
});

for (const operation of ['key', 'menu', 'drag'] as const) {
  test(`絞り込み中の完了カードを${operation}で畳んだ列へ戻し、全体進捗を更新する`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    const board = sample();
    const completed = board.columns[3]!.tasks[0]!;
    const destination = board.columns[2]!;
    let reopened = 0;
    await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => call.fulfill(board));
    await routeOperation(page, taskReopen, { slug: 'aoba' }, (call) => {
      expect(call.input.task_id).toBe(completed.id);
      reopened++;
      board.columns[3]!.tasks = [];
      completed.completed_at = null;
      destination.tasks.push(completed);
      return call.fulfill({ task_id: completed.id, sprint_id: board.sprint!.id, column_id: destination.id });
    });
    await routeOperation(page, taskColumnMove, { slug: 'aoba' }, (call) =>
      call.fulfill({ task_id: call.input.task_id, column_id: call.input.column_id }),
    );
    await page.goto(`${PATH}?story=${STORY.id}`);
    const target = page.locator('.board-col').nth(2);
    const toggle = target.getByRole('button', { name: 'レビューの開閉', exact: true });
    await toggle.click();
    const card = page.locator(`[data-card-id="${completed.id}"]`);
    await expect(card).toHaveAttribute('tabindex', '0');
    await expect(card.getByRole('button', { name: /^完了を戻す:/ })).toHaveCount(0);
    if (operation === 'key') await card.press('Alt+ArrowLeft');
    else if (operation === 'menu') {
      await card.locator('.row-menu-btn').click();
      await card.getByRole('menuitem', { name: '前の列へ（完了を戻す）', exact: true }).click();
    } else await dragTo(page, card.locator('.card-title'), target.locator('.board-col-head'), 'middle');
    await expect.poll(() => reopened).toBe(1);
    await expect(page.locator('.board-col.is-done .card')).toHaveCount(0);
    await expect(target.locator('.board-col-n')).toHaveText('1');
    await expect(target.locator('.board-col-pts')).toHaveText('2 pt');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    if (operation !== 'drag') await expect(toggle).toBeFocused();
    await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
    await expect(page).toHaveURL(new RegExp(`story=${STORY.id}`));
    await expectSprintTotals(page, '完了 0 / 10 pt（0%）');
    await toggle.click();
    await expect(target.locator('.card-title')).toHaveText(completed.title);
    await expect(page.locator('.card')).toHaveCount(3);
  });
}

test('絞り込み中も戻せない完了カードは理由を伝え、書き込まない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const board = sample();
  const task = board.columns[3]!.tasks[0]!;
  task.reopenable = false;
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().includes('/task-reopen')) sent++;
  });
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, board);
  await page.goto(`${PATH}?story=${STORY.id}`);
  const card = page.locator(`[data-card-id="${task.id}"]`);
  await expect(card).toHaveClass(/is-reopen-blocked/);
  await expect(card).toHaveAccessibleDescription(/完了を戻せません/);
  await card.press('Alt+ArrowLeft');
  await expect(
    page.getByRole('status').filter({
      hasText:
        '完了したストーリーの下のタスクは戻せません。先にストーリーの完了を取り消してください。一覧を読み直します',
    }),
  ).toBeVisible();
  await waitForSettled(page);
  expect(sent).toBe(0);
  await expect(page.locator('.story-filter-band')).toContainText(STORY.title);
  await expect(page.locator('.card')).toHaveCount(3);
});

for (const theme of A11Y_THEMES) {
  test(`ストーリー強調の二重の輪郭と文字のコントラスト: ${theme}`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, sprintBoard, { slug: 'aoba' }, sample());
    await page.goto(PATH);
    await applyTheme(page, theme);
    await page.locator('.card-parent').first().hover();
    await expect(page.locator('.card.is-story-highlighted')).toHaveCount(3);
    await expect(page.locator('.card.is-story-highlighted').first()).toHaveCSS('outline-style', 'double');
    expect(await findA11yViolations(page, '.story-board')).toEqual([]);
    await page.locator('.card-parent').first().focus();
    expect(await findA11yViolations(page, '.story-board')).toEqual([]);
    await page.locator('.card-parent').first().click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await findA11yViolations(page, '.story-board')).toEqual([]);
  });
}
