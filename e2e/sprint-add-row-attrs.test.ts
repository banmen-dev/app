// ボードの列の末尾の追加の行で、題に加えて担当と期日を選んで作る（#1501）。
// 一本道: 自分のワークスペースでスプリントを作って始める → 未着手の列の行の下のチップで担当（自分）と期日を選ぶ → 題を打って Enter
// → 担当と期日の付いたカードが列の末尾に出て、行の題、担当、期日は空に戻る → 題だけでも今どおり作れる
// → 一度決めた期日は窓の「クリア」で外せる → 作るのが断られたら、題も担当も期日も残る
// → チップを選んでから Esc で書きかけを捨てると、選んだ値も消える → 読み直しても担当と期日が残る。
// 最後に、チップの並んだ盤を4つの見た目で axe にかける。暦に無い期日を断るのは API のテスト（test/task.test.ts）が確かめる
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  createWorkspace,
  expectBoardHeading,
  expectNoA11yViolationsInThemes,
  signIn,
  waitForResponses,
  watchViolations,
} from './helpers.ts';
import { failOperation } from './operations.ts';
import { taskCreate } from '../src/shared/operations/task/index.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const cardOf = (page: Page, title: string): Locator =>
  page.locator('.card').filter({ has: page.locator('.card-title', { hasText: title }) });
const titlesIn = (page: Page, column: string) =>
  page.getByRole('region', { name: column, exact: true }).locator('.card-title');

test('列の末尾の行で担当と期日を選んで作ると、カードに付き、行は空に戻る。題だけでも作れる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, `担当と期日で作る ${test.info().repeatEachIndex}-${test.info().retry}`);
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const create = page.getByRole('dialog', { name: 'スプリントを作る' });
  await create.getByLabel('開始日').fill('2099-06-01');
  await create.getByLabel('長さ（日）').fill('14');
  await create.getByLabel('名前（任意）').fill('第5回');
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: '始める: スプリント「第5回」' }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める' }).click();
  await expect(start).toBeHidden();
  await page.getByRole('link', { name: 'ボード', exact: true }).click();
  await expectBoardHeading(page, '第5回');

  // 完了でない列ごとに、行の下に担当と期日のチップが未設定で並ぶ。完了の列には無い
  await expect(page.getByRole('group', { name: /^作るタスクの担当と期日: / })).toHaveCount(3);
  await expect(page.getByRole('region', { name: '完了', exact: true }).locator('.draft-attrs')).toHaveCount(0);
  const todo = page.getByRole('region', { name: '未着手', exact: true });
  const attrs = todo.getByRole('group', { name: '作るタスクの担当と期日: 未着手' });
  const assigneeChip = (value: string) => attrs.getByRole('button', { name: `担当: ${value}` });
  const dueChip = (value: string) => attrs.getByRole('button', { name: `期日: ${value}` });
  await expect(assigneeChip('未設定')).toBeVisible();
  await expect(dueChip('未設定')).toBeVisible();

  // 担当: 窓を開いて候補が読めたら「自分に割り当てる」を選ぶ
  await assigneeChip('未設定').click();
  const assigneeWindow = page.getByRole('dialog', { name: '担当を選ぶ' });
  await expect(assigneeWindow.getByRole('menuitemradio', { name: 'ミナト' })).toBeVisible();
  await assigneeWindow.getByRole('menuitem', { name: '自分に割り当てる' }).click();
  await expect(assigneeWindow).toBeHidden();
  await expect(assigneeChip('ミナト')).toBeFocused();

  // 期日: 日付の欄に入れて Enter で決める
  await dueChip('未設定').click();
  const dueWindow = page.getByRole('dialog', { name: '期日を選ぶ' });
  await dueWindow.getByLabel('期日', { exact: true }).fill('2099-06-10');
  await dueWindow.getByLabel('期日', { exact: true }).press('Enter');
  await expect(dueWindow).toBeHidden();
  await expect(dueChip('6/10')).toBeVisible();

  // 題を打って Enter で、担当と期日の付いたカードが列の末尾に出る。行の題、担当、期日は空に戻る
  const input = page.getByRole('textbox', { name: 'タスクを足す: 未着手' });
  const created = waitForResponses(page, '/task-create');
  await input.fill('見積もりを送る');
  await input.press('Enter');
  await created;
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る']);
  const card = cardOf(page, '見積もりを送る');
  await expect(card.getByRole('button', { name: '担当: ミナト' })).toBeVisible();
  await expect(card.locator('.card-meta')).toContainText('6/10');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(assigneeChip('未設定')).toBeVisible();
  await expect(dueChip('未設定')).toBeVisible();

  // 題だけでも今どおり作れる（担当も期日も無い）
  await input.fill('請求書を出す');
  await input.press('Enter');
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る', '請求書を出す']);
  const plain = cardOf(page, '請求書を出す');
  await expect(plain.getByRole('button', { name: '担当: 未設定' })).toBeVisible();
  await expect(plain.locator('.card-meta')).toHaveCount(0);

  // 一度決めた期日は、窓を開き直して「クリア」で外せる（欄を離れる blur で窓を閉じない）
  await dueChip('未設定').click();
  await dueWindow.getByLabel('期日', { exact: true }).fill('2099-06-11');
  await dueWindow.getByLabel('期日', { exact: true }).press('Enter');
  await expect(dueChip('6/11')).toBeVisible();
  // 決めた値のまま開き直して Enter でも閉じる
  await dueChip('6/11').click();
  await dueWindow.getByLabel('期日', { exact: true }).press('Enter');
  await expect(dueWindow).toBeHidden();
  await expect(dueChip('6/11')).toBeFocused();
  await dueChip('6/11').click();
  await dueWindow.getByRole('button', { name: 'クリア' }).click();
  await expect(dueWindow).toBeHidden();
  await expect(dueChip('未設定')).toBeVisible();

  // 作るのが断られたら、理由を出し、題も担当も期日も残す（送り直せる）
  await assigneeChip('未設定').click();
  await expect(assigneeWindow.getByRole('menuitemradio', { name: 'ミナト' })).toBeVisible();
  await assigneeWindow.getByRole('menuitem', { name: '自分に割り当てる' }).click();
  await dueChip('未設定').click();
  await dueWindow.getByLabel('期日', { exact: true }).fill('2099-06-12');
  await dueWindow.getByLabel('期日', { exact: true }).press('Enter');
  await expect(dueChip('6/12')).toBeVisible();
  const unroute = await failOperation(page, taskCreate, { slug: 'aoba' }, 400, 'invalid_input');
  await input.fill('断られる札');
  await input.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: '作れませんでした' })).toBeVisible();
  await unroute();
  await expect(input).toHaveValue('断られる札');
  await expect(assigneeChip('ミナト')).toBeVisible();
  await expect(dueChip('6/12')).toBeVisible();
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る', '請求書を出す']);

  // チップを選んだまま Esc で書きかけを捨てると、選んだ値も消える
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(assigneeChip('未設定')).toBeVisible();
  await expect(dueChip('未設定')).toBeVisible();

  // 読み直しても、作ったカードに担当と期日が残る
  await page.reload();
  await expectBoardHeading(page, '第5回');
  await expect(cardOf(page, '見積もりを送る').getByRole('button', { name: '担当: ミナト' })).toBeVisible();
  await expect(cardOf(page, '見積もりを送る').locator('.card-meta')).toContainText('6/10');
  // 断られた作成（わざと 400 にした1回）だけが、読み込みの失敗としてコンソールに出る
  expect(await collect()).toEqual(['Failed to load resource: the server responded with a status of 400 (Bad Request)']);

  await expectNoA11yViolationsInThemes(page, 'sprint');
});
