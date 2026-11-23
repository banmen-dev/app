// ボードのカードの上で直す（#1499）。ポイントと担当のチップを押して選ぶと保存され、列の見出しの合計も変わる。
// 担当の窓は文字で候補を絞れ、先頭の「自分に割り当てる」と「担当なし」も選べる。題の横の鉛筆を押すと、題がその場で入力欄に替わり、
// Enter で保存、Esc で元の題に戻る。保存が断られたら理由をトーストで出し、元の値に戻す。完了したカードのチップと鉛筆は押せず、理由が読める。
// チップと鉛筆を押しても、カードはドラッグされない。最後に、担当の窓を開いた状態を axe にかける
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  createWorkspace,
  dragTo,
  expectBoardHeading,
  expectNoA11yViolationsInThemes,
  signIn,
  waitForResponses,
  watchViolations,
} from './helpers.ts';
import { failOperation } from './operations.ts';
import { taskUpdate } from '../src/shared/operations/task/index.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const cardOf = (page: Page, title: string): Locator =>
  page.locator('.card').filter({ has: page.locator('.card-title', { hasText: title }) });
const columnOf = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

async function startBoard(page: Page, titles: readonly string[]): Promise<void> {
  const name = `カードで直す ${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, name);
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

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('カードのチップでポイントと担当を選ぶと保存され、列の合計が変わる。担当の窓は絞り込め、自分に割り当てられる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await startBoard(page, ['見積もりを出す']);
  const card = cardOf(page, '見積もりを出す');
  const todo = columnOf(page, '未着手');
  await expect(todo.locator('.board-col-pts')).toHaveText('0 pt');

  // ポイント
  await card.getByRole('button', { name: 'ポイント: 未設定' }).click();
  const pointsMenu = page.getByRole('menu', { name: 'ポイントを選ぶ' });
  const pointsSaved = waitForResponses(page, '/task-update');
  await pointsMenu.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await pointsSaved;
  await expect(card.getByRole('button', { name: 'ポイント: 5 pt' })).toBeFocused();
  await expect(todo.locator('.board-col-pts')).toHaveText('5 pt');

  // 担当: 窓を開くと絞り込みの欄にフォーカスがあり、当たらない文字では候補が無いと知らせる
  await card.getByRole('button', { name: '担当: 未設定' }).click();
  const assigneeWindow = page.getByRole('dialog', { name: '担当を選ぶ' });
  const search = assigneeWindow.getByRole('searchbox', { name: '担当を探す' });
  await expect(search).toBeFocused();
  await expect(assigneeWindow.getByRole('menuitem', { name: '自分に割り当てる' })).toBeVisible();
  // 空の欄の Enter では選ばない（開いた直後の反射の Enter で担当を替えない）
  await search.press('Enter');
  await expect(assigneeWindow).toBeVisible();
  await expect(card.getByRole('button', { name: '担当: 未設定' })).toHaveCount(1);
  // 先頭の候補から ↑ で欄へ戻る
  await search.press('ArrowDown');
  await expect(assigneeWindow.getByRole('menuitem', { name: '自分に割り当てる' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(search).toBeFocused();
  // 欄の ↑ は何もしない（候補へ飛ばない）
  await search.press('ArrowUp');
  await expect(search).toBeFocused();
  await search.fill('該当しない名前');
  await expect(assigneeWindow.getByText('当たる候補はありません')).toBeVisible();
  // 絞り込んでいる間は「自分に割り当てる」を隠す
  await expect(assigneeWindow.getByRole('menuitem', { name: '自分に割り当てる' })).toHaveCount(0);
  await search.fill('');
  const assigned = waitForResponses(page, '/task-assign');
  await assigneeWindow.getByRole('menuitem', { name: '自分に割り当てる' }).click();
  await assigned;
  await expect(card.getByRole('button', { name: '担当: ミナト' })).toBeFocused();

  // 文字で絞って Enter で先頭の候補（担当なし）を選ぶ
  await card.getByRole('button', { name: '担当: ミナト' }).click();
  await search.fill('担当なし');
  const cleared = waitForResponses(page, '/task-assign');
  await search.press('Enter');
  await cleared;
  await expect(card.getByRole('button', { name: '担当: 未設定' })).toBeVisible();

  // 読み直しても同じ値
  await page.reload();
  await expect(cardOf(page, '見積もりを出す').getByRole('button', { name: 'ポイント: 5 pt' })).toBeVisible();
  await expect(columnOf(page, '未着手').locator('.board-col-pts')).toHaveText('5 pt');
  expect(await collect()).toEqual([]);
});

test('鉛筆で題をその場で書き換える。Enter で保存、Esc で元の題に戻る。断られたら理由を出して戻す', async ({ page }) => {
  await startBoard(page, ['題を直す札']);
  const card = cardOf(page, '題を直す札');
  const pencil = card.getByRole('button', { name: 'タイトルを直す: 題を直す札' });

  // Esc で元に戻り、鉛筆へフォーカスが戻る
  await card.hover();
  await pencil.click();
  const input = card.getByRole('textbox', { name: 'タイトル' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('題を直す札');
  await input.fill('書きかけ');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(card.locator('.card-title')).toHaveText('題を直す札');
  await expect(pencil).toBeFocused();

  // Enter で保存する
  await pencil.click();
  await input.fill('直した題の札');
  const saved = waitForResponses(page, '/task-update');
  await input.press('Enter');
  await saved;
  const renamed = cardOf(page, '直した題の札');
  await expect(renamed.locator('.card-title')).toHaveText('直した題の札');
  await expect(renamed.getByRole('button', { name: 'タイトルを直す: 直した題の札' })).toBeFocused();

  // フォーカスが外れたときも保存し、移った先からフォーカスを奪わない
  const renamedPencil = renamed.getByRole('button', { name: 'タイトルを直す: 直した題の札' });
  await renamedPencil.click();
  await renamed.getByRole('textbox', { name: 'タイトル' }).fill('離れて直した札');
  const blurSaved = waitForResponses(page, '/task-update');
  await renamed.getByRole('textbox', { name: 'タイトル' }).press('Tab');
  await blurSaved;
  const left = cardOf(page, '離れて直した札');
  // Tab で移った次の操作（ポイントのチップ）にフォーカスが残る（題が替わってカードを題で引き直すので、引き直した側で確かめる）
  await expect(left.getByRole('button', { name: 'ポイント: 未設定' })).toBeFocused();
  await expect(left.locator('.card-title')).toHaveText('離れて直した札');

  // 空の題で離れたら、理由を出して元の題に戻す（送らない）
  await left.getByRole('button', { name: 'タイトルを直す: 離れて直した札' }).click();
  await left.getByRole('textbox', { name: 'タイトル' }).fill('   ');
  await left.getByRole('textbox', { name: 'タイトル' }).press('Tab');
  await expect(left.getByRole('textbox', { name: 'タイトル' })).toHaveCount(0);
  await expect(left.locator('.card-title')).toHaveText('離れて直した札');

  // 断られたら、理由を出して元の題に戻す
  await failOperation(page, taskUpdate, { slug: 'aoba' }, 409, 'conflict', {
    details: { reason: 'stale', current: { title: '離れて直した札' } },
  });
  await left.getByRole('button', { name: 'タイトルを直す: 離れて直した札' }).click();
  await left.getByRole('textbox', { name: 'タイトル' }).fill('通らない題');
  await left.getByRole('textbox', { name: 'タイトル' }).press('Enter');
  await expect(page.locator('.toasts:visible .toast', { hasText: 'ほかの人が同時に直したため' })).toBeVisible();
  await expect(left.locator('.card-title')).toHaveText('離れて直した札');
});

test('完了したカードのチップと鉛筆は押せず理由が読める。チップと鉛筆からはドラッグが始まらない', async ({ page }) => {
  await startBoard(page, ['動かさない札', '終える札']);
  const still = cardOf(page, '動かさない札');

  // チップと鉛筆を押したまま動かしても、カードをつかまない
  for (const control of [still.getByRole('button', { name: 'ポイント: 未設定' }), still.locator('.card-edit-btn')]) {
    await still.hover();
    const box = await control.boundingBox();
    if (box === null) throw new Error('操作が見えていない');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40, { steps: 6 });
    await expect(page.locator('.card.is-dragging')).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.press('Escape');
  }

  // 完了の列へ落として完了にする
  const completed = waitForResponses(page, '/task-complete');
  // つかむのは題のリンク（カードの真ん中は、下の段のチップのボタンに当たりうる。ボタンからは動き出さない）
  await dragTo(page, cardOf(page, '終える札').locator('.card-title'), columnOf(page, '完了'), 'middle');
  await completed;
  const done = columnOf(page, '完了').locator('.card').filter({ hasText: '終える札' });
  await expect(done).toBeVisible();
  const points = done.getByRole('button', { name: 'ポイント: 未設定' });
  await expect(points).toHaveAttribute('aria-disabled', 'true');
  await expect(points).toHaveAccessibleDescription('このタスクは完了になっているため、ポイントは直せません。');
  await expect(done.getByRole('button', { name: '担当: 未設定' })).toHaveAccessibleDescription(
    'このタスクは完了になっているため、担当は替えられません。',
  );
  const pencil = done.getByRole('button', { name: 'タイトルを直す: 終える札' });
  await expect(pencil).toHaveAttribute('aria-disabled', 'true');
  await expect(pencil).toHaveAccessibleDescription('このタスクは完了になっているため、タイトルは直せません。');
  await pencil.click({ force: true });
  await expect(done.getByRole('textbox', { name: 'タイトル' })).toHaveCount(0);
  // aria-disabled のボタンは Playwright が押せるまで待つので、force で押して開かないことを確かめる
  await points.click({ force: true });
  await expect(page.getByRole('menu', { name: 'ポイントを選ぶ' })).toHaveCount(0);

  // 担当の窓を開いた状態を axe にかける
  await still.getByRole('button', { name: '担当: 未設定' }).click();
  await expect(page.getByRole('dialog', { name: '担当を選ぶ' })).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'sprint');
});
