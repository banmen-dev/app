// ボードのカードの「⋯」の「列を変更」「リンクをコピー」「親を変更」（#1500）。
// 列を選ぶとカードがその列の末尾へ移り、完了の列を選ぶと完了になる。リンクをコピーすると引き出しを開く URL が入り、開くと引き出しが開く。
// 親を選ぶか「親なし」を選ぶと保存され、カードの親の表示が変わる。完了したカードでは列と親の変更が押せず、理由が読める。
// 断られたら理由がトーストで出て、カードは元の列と親に戻る。最後に、列のダイアログを開いた状態を axe にかける
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  addEpicRow,
  addStoryRow,
  createWorkspace,
  expectBoardHeading,
  expectNoA11yViolationsInThemes,
  rowMenuItem,
  rowMenuToggle,
  signIn,
  waitForResponses,
  watchViolations,
} from './helpers.ts';
import { failOperation } from './operations.ts';
import { taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { taskMove } from '../src/shared/operations/task/index.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const cardOf = (page: Page, title: string): Locator =>
  page.locator('.card').filter({ has: page.locator('.card-title', { hasText: title }) });
const columnOf = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

// 親の候補にするエピックとストーリーをバックログで作り、スプリントを始めて、未着手の列にカードを足す
async function startBoard(page: Page, titles: readonly string[]): Promise<void> {
  const name = `カードの操作 ${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, name);
  await addEpicRow(page, '配送の基盤');
  await addStoryRow(page, '通知を整える', '配送の基盤');
  await addStoryRow(page, '検索を速くする');
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const create = page.getByRole('dialog', { name: 'スプリントを作る' });
  await create.getByLabel('開始日').fill('2099-06-01');
  await create.getByLabel('長さ（日）').fill('14');
  await create.getByLabel('名前（任意）').fill('第3回');
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: '始める: スプリント「第3回」' }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める' }).click();
  await expect(start).toBeHidden();
  await page.getByRole('link', { name: 'ボード', exact: true }).click();
  await expectBoardHeading(page, '第3回');
  const draft = page.getByRole('textbox', { name: 'タスクを足す: 未着手' });
  for (const title of titles) {
    const created = waitForResponses(page, '/task-create');
    await draft.fill(title);
    await draft.press('Enter');
    await created;
    await expect(cardOf(page, title)).toBeVisible();
  }
}

async function chooseColumn(page: Page, title: string, column: string): Promise<void> {
  await rowMenuToggle(page, title).click();
  await rowMenuItem(page, title, '列を変更').click();
  const dialog = page.getByRole('dialog', { name: `「${title}」の列を変更` });
  await dialog.getByLabel('移す先の列').selectOption({ label: column });
  await dialog.getByRole('button', { name: '移す' }).click();
  await expect(dialog).toBeHidden();
}

async function chooseParent(page: Page, title: string, parent: string): Promise<void> {
  const choices = waitForResponses(page, '/story-choices');
  await rowMenuToggle(page, title).click();
  await rowMenuItem(page, title, '親を変更').click();
  await choices;
  const dialog = page.getByRole('dialog', { name: `「${title}」の親を移す` });
  await dialog.getByLabel('移す先').selectOption({ label: parent });
  await dialog.getByRole('button', { name: '移す' }).click();
  await expect(dialog).toBeHidden();
}

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('「列を変更」で選んだ列の末尾へ移り、完了の列を選ぶと完了になる', async ({ page }) => {
  const collect = await watchViolations(page);
  await startBoard(page, ['見積もりを出す', '段取りを組む']);

  // 離れた列へ一度で移す。先に置いたカードの後ろ（末尾）に並ぶ
  const firstMoved = waitForResponses(page, '/task-column-move');
  await chooseColumn(page, '段取りを組む', 'レビュー');
  expect((await firstMoved).ok()).toBe(true);
  const secondMoved = waitForResponses(page, '/task-column-move');
  await chooseColumn(page, '見積もりを出す', 'レビュー');
  expect((await secondMoved).ok()).toBe(true);
  await expect(columnOf(page, 'レビュー').locator('.card-title')).toHaveText(['段取りを組む', '見積もりを出す']);
  // 閉じたら「⋯」へフォーカスが戻る
  await expect(rowMenuToggle(page, '見積もりを出す')).toBeFocused();
  await page.reload();
  await expect(columnOf(page, 'レビュー').locator('.card-title')).toHaveText(['段取りを組む', '見積もりを出す']);

  // 完了の列を選ぶと完了にする（task-complete）
  const completed = waitForResponses(page, '/task-complete');
  await chooseColumn(page, '見積もりを出す', '完了');
  expect((await completed).ok()).toBe(true);
  await expect(columnOf(page, '完了').locator('.card-title')).toHaveText(['見積もりを出す']);
  await expect(cardOf(page, '見積もりを出す')).toHaveClass(/is-done/);

  // 列のダイアログを開いた状態を axe にかける
  await rowMenuToggle(page, '段取りを組む').click();
  await rowMenuItem(page, '段取りを組む', '列を変更').click();
  const dialog = page.getByRole('dialog', { name: '「段取りを組む」の列を変更' });
  await expect(dialog.getByLabel('移す先の列')).toBeFocused();
  // 今の列（レビュー）は候補に無く、完了の列は最後
  await expect(dialog.getByRole('option')).toHaveText(['未着手', '作業中', '完了']);
  await expectNoA11yViolationsInThemes(page, 'sprint');
  expect(await collect()).toEqual([]);
});

test('「親を変更」でストーリーか親なしを選ぶと保存され、カードの親の表示が変わる', async ({ page }) => {
  await startBoard(page, ['画面を直す']);
  const card = cardOf(page, '画面を直す');
  await expect(card.locator('.card-parent')).toHaveCount(0);

  // 候補は親のエピックでまとめる。親の無いカードには「親なし」を出さない
  const firstChoices = waitForResponses(page, '/story-choices');
  await rowMenuToggle(page, '画面を直す').click();
  await rowMenuItem(page, '画面を直す', '親を変更').click();
  await firstChoices;
  const first = page.getByRole('dialog', { name: '「画面を直す」の親を移す' });
  await expect(first.getByRole('option')).toHaveText(['通知を整える', '検索を速くする']);
  await expect(first.locator('optgroup').first()).toHaveAttribute('label', '配送の基盤');
  await first.getByRole('button', { name: 'やめる' }).click();
  await expect(rowMenuToggle(page, '画面を直す')).toBeFocused();

  const moved = waitForResponses(page, '/task-move');
  await chooseParent(page, '画面を直す', '通知を整える');
  expect((await moved).ok()).toBe(true);
  await expect(card.locator('.card-parent')).toHaveText('通知を整える');
  await page.reload();
  await expect(card.locator('.card-parent')).toHaveText('通知を整える');

  // 親があれば先頭に「親なし」を置き、今の親は候補に出さない
  const choices = waitForResponses(page, '/story-choices');
  await rowMenuToggle(page, '画面を直す').click();
  await rowMenuItem(page, '画面を直す', '親を変更').click();
  await choices;
  const dialog = page.getByRole('dialog', { name: '「画面を直す」の親を移す' });
  await expect(dialog.getByRole('option')).toHaveText(['親なし', '検索を速くする']);
  await dialog.getByRole('button', { name: 'やめる' }).click();
  await expect(rowMenuToggle(page, '画面を直す')).toBeFocused();

  const cleared = waitForResponses(page, '/task-move');
  await chooseParent(page, '画面を直す', '親なし');
  expect((await cleared).ok()).toBe(true);
  await expect(card.locator('.card-parent')).toHaveCount(0);
  await page.reload();
  await expect(card.locator('.card-parent')).toHaveCount(0);
});

test('「リンクをコピー」で引き出しを開く URL が入り、開くと引き出しが開く', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await startBoard(page, ['手順を書く']);
  await rowMenuToggle(page, '手順を書く').click();
  await rowMenuItem(page, '手順を書く', 'リンクをコピー').click();
  await expect(
    page.locator('.toasts:visible .toast', { hasText: '「手順を書く」のリンクをコピーしました' }),
  ).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/^https?:\/\/[^/]+\/aoba\/w\/[0-9a-f-]{36}\/board\?task=[0-9a-f-]{36}$/);

  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByRole('dialog', { name: '手順を書く' })).toBeVisible();
  await other.close();
});

test('完了したカードでは列と親の変更が押せず、押すと理由をトーストで知らせる', async ({ page }) => {
  await startBoard(page, ['片付ける']);
  const completed = waitForResponses(page, '/task-complete');
  await chooseColumn(page, '片付ける', '完了');
  await completed;
  await expect(cardOf(page, '片付ける')).toHaveClass(/is-done/);

  const column = rowMenuItem(page, '片付ける', '列を変更');
  const parent = rowMenuItem(page, '片付ける', '親を変更');
  await expect(column).toHaveAttribute('aria-disabled', 'true');
  await expect(column).toHaveAccessibleDescription(
    'このタスクは完了になっているため、列は変えられません。先に完了を戻してください。',
  );
  await expect(parent).toHaveAttribute('aria-disabled', 'true');
  await expect(parent).toHaveAccessibleDescription('このタスクは完了になっているため、親は変えられません。');
  // 押すとメニューが閉じ、理由をトーストで知らせる。ダイアログは開かない
  await rowMenuToggle(page, '片付ける').click();
  await parent.click({ force: true });
  await expect(page.locator('.toasts:visible .toast', { hasText: '親は変えられません' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowMenuToggle(page, '片付ける')).toBeFocused();
  // リンクのコピーは完了したカードでも使える
  await expect(rowMenuItem(page, '片付ける', 'リンクをコピー')).not.toHaveAttribute('aria-disabled', 'true');
});

test('断られたら理由がトーストで出て、カードは元の列と親に戻る', async ({ page }) => {
  await startBoard(page, ['戻る札']);
  const card = cardOf(page, '戻る札');

  await failOperation(page, taskColumnMove, { slug: 'aoba' }, 409, 'conflict', { details: { reason: 'changed' } });
  await chooseColumn(page, '戻る札', 'レビュー');
  await expect(page.locator('.toasts:visible .toast').filter({ hasText: 'ほかの画面で変わったため' })).toBeVisible();
  await expect(columnOf(page, '未着手').locator('.card-title')).toHaveText(['戻る札']);

  await failOperation(page, taskMove, { slug: 'aoba' }, 409, 'conflict', { details: { reason: 'parent_completed' } });
  await chooseParent(page, '戻る札', '検索を速くする');
  await expect(
    page.locator('.toasts:visible .toast').filter({ hasText: '完了したストーリーの下へは移せません' }),
  ).toBeVisible();
  await expect(card.locator('.card-parent')).toHaveCount(0);
});
