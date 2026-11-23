import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled, watchViolations } from './helpers.ts';
import { mockOperation, rewriteOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const TEAM = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const LABELS = [
  '選んだカードを隣の列へ（完了のカードは左で戻す）',
  '選んだ未完了カードを列の中で動かす',
  '列の末尾の空の行に題を打ち、タスクを足す',
];
const KEYS = ['Alt + ← →', 'Alt + ↑ ↓', 'Enter'];

test.beforeEach(async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
});

test('ボード下の案内を出さず、カードの読み上げ説明を残し、? に操作を3項目で出す。ほかの画面には残さない', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await page.goto(`${TEAM}/board`);
  const cards = page.locator('.card');
  await expect(cards).toHaveCount(4);
  // 書き込める状態の描画を待ってから、説明と案内の不存在を確かめる。
  await expect(page.locator('.card .row-menu-btn')).toHaveCount(4);
  await expect(
    page.locator('p.action-note').filter({ hasText: /カードを別の列へ|末尾の空の行に題を打って/ }),
  ).toHaveCount(0);
  const explanation = page.locator('#sprint-board-key-hint');
  await expect(explanation).toHaveClass('visually-hidden');
  await expect(explanation).toContainText('完了のカードは Alt と ← か「⋯」で戻せます。');
  const card = page.getByRole('article', { name: SAMPLE_BOARD.columns[0]!.tasks[0]!.title, exact: true });
  await card.focus();
  await expect(card).toHaveAttribute('aria-describedby', /sprint-board-key-hint/);
  await expect(card).toHaveAccessibleDescription(/カードを別の列へドラッグして移すか/);
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'ショートカットの一覧', exact: true });
  await expect(help).toBeVisible();
  const screen = help
    .locator('.shortcut-group')
    .filter({ has: page.getByRole('heading', { name: 'この画面', exact: true }) });
  for (const [index, label] of LABELS.entries()) {
    const row = screen.locator('.shortcut-row').filter({ has: page.getByText(label, { exact: true }) });
    await expect(row).toBeVisible();
    await expect(row.locator('kbd')).toHaveText(KEYS[index]!);
  }
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(card).toBeFocused();
  await page.goto(TEAM);
  await waitForSettled(page);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  for (const label of LABELS) await expect(help.getByText(label, { exact: true })).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('閉じたワークスペースではカードの移動・追加のキーを一覧に出さない', async ({ page }) => {
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.goto(`${TEAM}/board`);
  await expect(page.locator('.card')).toHaveCount(4);
  await waitForSettled(page);
  await expect(page.locator('.card .row-menu-btn')).toHaveCount(0);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'ショートカットの一覧', exact: true });
  await expect(help).toBeVisible();
  for (const label of LABELS) await expect(help.getByText(label, { exact: true })).toHaveCount(0);
});

test('390pxでもスプリントの3項目の名前とキーが横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${TEAM}/board`);
  await expect(page.locator('.card .row-menu-btn')).toHaveCount(4);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'ショートカットの一覧', exact: true });
  await expect(help).toBeVisible();
  const sheet = help.locator('.dialog-sheet');
  expect(await sheet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const label of LABELS) await expect(help.getByText(label, { exact: true })).toBeVisible();
});
