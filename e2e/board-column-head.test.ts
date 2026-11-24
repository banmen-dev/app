// ボードの列の見出しの上限、名前の書き換え、「⋯」の移動（#1504）。sprint-board と列の操作は差し替え、seed の行を書き換えない
import { columnMove, columnUpdate } from '../src/shared/operations/column/index.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { mockOperation, routeOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const TEAM = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const [TODO, DOING, REVIEW] = SAMPLE_BOARD.columns;

// 未着手は上限 1 で 2 件（超えている）、作業中は上限 1 で 1 件（ちょうど。超えていない）
const LIMITED: OutputOf<typeof sprintBoard> = {
  ...SAMPLE_BOARD,
  columns: SAMPLE_BOARD.columns.map((column) =>
    column.id === TODO!.id
      ? { ...column, wip_limit: 1 }
      : column.id === DOING!.id
        ? { ...column, wip_limit: 1 }
        : column,
  ),
};

function columnOf(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('region', { name, exact: true });
}

test('上限を超えた列は件数を警告の色で出し、リーダーは「⋯」から上限を決め、名前を書き換え、左右へ移せる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, LIMITED);
  await page.goto(`${TEAM}/board`);

  const todo = columnOf(page, '未着手');
  const over = todo.locator('.board-col-n');
  await expect(over).toHaveClass(/is-over/);
  await expect(over).toHaveText('2 / 1');
  await expect(todo.locator('.board-col-head .visually-hidden')).toHaveText('2 件。上限の 1 件を超えています');
  const within = columnOf(page, '作業中').locator('.board-col-n');
  await expect(within).not.toHaveClass(/is-over/);
  await expect(columnOf(page, '作業中').locator('.board-col-head .visually-hidden')).toHaveText('1 件（上限 1 件）');

  // 上限を超えていても、その列で作れる（足す行は残る）
  await expect(page.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true })).toBeVisible();

  // 完了の列には名前のボタンも「⋯」も無い
  const done = columnOf(page, '完了');
  // 完了の列のカードには、戻すための「⋯」がある。見るのは列の頭だけ
  const doneHead = done.locator('.board-col-head');
  await expect(doneHead.getByRole('button', { name: /^操作:/ })).toHaveCount(0);
  await expect(doneHead.getByRole('button', { name: /名前を変更/ })).toHaveCount(0);

  // 上限を決める
  const updates: unknown[] = [];
  await routeOperation(page, columnUpdate, { slug: 'aoba' }, async (call) => {
    updates.push(call.input);
    if (call.input.name === 'レビュー') {
      await call.fail(409, 'conflict', { details: { reason: 'duplicate_name' } });
      return;
    }
    await call.fulfill({
      column: {
        id: call.input.column_id,
        name: call.input.name ?? '作業中',
        is_done: false,
        wip_limit: call.input.wip_limit ?? null,
        task_count: 1,
      },
    });
  });
  const doingMenu = page.getByRole('button', { name: '操作: 列「作業中」', exact: true });
  await doingMenu.click();
  await page.getByRole('menuitem', { name: '上限を決める', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '列の上限', exact: true });
  const field = dialog.getByRole('textbox', { name: '上限（件）', exact: true });
  await expect(field).toHaveValue('1');
  // 0 と、数として読めない入力は送らず、欄に理由を出す（空と取り違えて上限を外さない）
  for (const raw of ['0', '3e', '100', '-1', '2.5']) {
    await field.fill(raw);
    await dialog.getByRole('button', { name: '決める', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('1〜99 の整数を入れるか、空にしてください');
  }
  expect(updates).toEqual([]);
  await field.fill('');
  await dialog.getByRole('button', { name: '決める', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.toasts:visible .toast', { hasText: '「作業中」の上限を外しました' })).toBeVisible();
  expect(updates).toEqual([{ workspace_id: expect.any(String), column_id: DOING!.id, wip_limit: null }]);

  // 正しい数は数のまま送る（両端と、前後に空白のある数）
  for (const [raw, value] of [
    ['1', 1],
    ['99', 99],
    [' 5 ', 5],
    ['１２', 12],
  ] as const) {
    await doingMenu.click();
    await page.getByRole('menuitem', { name: '上限を決める', exact: true }).click();
    await field.fill(raw);
    await dialog.getByRole('button', { name: '決める', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(updates.at(-1)).toEqual({ workspace_id: expect.any(String), column_id: DOING!.id, wip_limit: value });
  }

  // 名前を書き換える。同じ名前はサーバーが断り、理由が出て元の名前に戻る。Esc で戻す
  await page.getByRole('button', { name: '列の名前を変更: 作業中', exact: true }).click();
  const nameField = page.getByRole('textbox', { name: '列の名前', exact: true });
  await expect(nameField).toBeFocused();
  await nameField.fill('レビュー');
  await nameField.press('Enter');
  await expect(page.locator('.toasts:visible .toast', { hasText: '同じ名前の列があります' })).toBeVisible();
  await page.getByRole('button', { name: '列の名前を変更: 作業中', exact: true }).click();
  await nameField.fill('進行中');
  await nameField.press('Escape');
  await expect(nameField).toBeHidden();
  await expect(page.getByRole('button', { name: '列の名前を変更: 作業中', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '列の名前を変更: 作業中', exact: true }).click();
  await nameField.fill('進行中');
  await nameField.press('Enter');
  await expect
    .poll(() => updates.at(-1))
    .toEqual({ workspace_id: expect.any(String), column_id: DOING!.id, name: '進行中' });

  // 左右の移動。左端の「左へ移動」と、完了の手前の「右へ移動」は押せない
  await page.getByRole('button', { name: '操作: 列「未着手」', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '左へ移動', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '操作: 列「レビュー」', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '右へ移動', exact: true })).toHaveAttribute('aria-disabled', 'true');
  const moves: unknown[] = [];
  await routeOperation(page, columnMove, { slug: 'aoba' }, async (call) => {
    moves.push(call.input);
    await call.fulfill({ column_id: call.input.column_id });
  });
  await page.getByRole('menuitem', { name: '左へ移動', exact: true }).click();
  await expect(
    page.locator('.toasts:visible .toast', { hasText: '「レビュー」を左から 2 番目へ移しました' }),
  ).toBeVisible();
  // 2番目の列の「左へ移動」は先頭へ（after_column_id は null）、先頭の列の「右へ移動」は2番目の列の後ろへ
  await page.getByRole('button', { name: '操作: 列「作業中」', exact: true }).click();
  await page.getByRole('menuitem', { name: '左へ移動', exact: true }).click();
  await expect(
    page.locator('.toasts:visible .toast', { hasText: '「作業中」を左から 1 番目へ移しました' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '操作: 列「未着手」', exact: true }).click();
  await page.getByRole('menuitem', { name: '右へ移動', exact: true }).click();
  await expect(
    page.locator('.toasts:visible .toast', { hasText: '「未着手」を左から 2 番目へ移しました' }),
  ).toBeVisible();
  expect(moves).toEqual([
    { workspace_id: expect.any(String), column_id: REVIEW!.id, after_column_id: TODO!.id },
    { workspace_id: expect.any(String), column_id: DOING!.id, after_column_id: null },
    { workspace_id: expect.any(String), column_id: TODO!.id, after_column_id: DOING!.id },
  ]);

  // 同じ名前を断った 409 だけが、読み込みの失敗としてコンソールに出る
  expect(await collect()).toEqual(['Failed to load resource: the server responded with a status of 409 (Conflict)']);
});

test('メンバーには列の「⋯」と名前の書き換えが出ず、上限を超えたことは読める', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, LIMITED);
  await page.goto(`${TEAM}/board`);
  const todo = columnOf(page, '未着手');
  await expect(todo.locator('.board-col-head .visually-hidden')).toHaveText('2 件。上限の 1 件を超えています');
  await expect(page.locator('.board-col-head .row-menu')).toHaveCount(0);
  await expect(page.locator('.board-col-name.is-action')).toHaveCount(0);
});
