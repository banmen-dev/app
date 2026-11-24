// 一本道: 設定で決まった欄を足す → 引き出しで欄を Markdown で書く → 空にすると「まだ書かれていません。」に戻る → 欄を削除すると引き出しに出ない。
// 同時に直されて断られたら、読み直しを促す。欄が空のタスクがあっても、木の行、見出しの集計、引き出し、計画の画面、スプリントに入れるダイアログに
// 「詳細 未記入」の印と件数は出さない（#1263）。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。行を足すテストは、自分で作ったワークスペースで行う
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { taskFieldSet } from '../src/shared/operations/task/task-field-set.ts';
import { addTaskRow, createWorkspace, signIn, watchViolations } from './helpers.ts';
import { failOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function openSettings(page: Page): Promise<void> {
  await page.locator('.route-tab', { hasText: /^\s*設定\s*$/ }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: '設定' })).toBeVisible();
}

test('設定で欄を足す → 欄が空でも木と見出しに未記入は出ない → 引き出しで書く → 空にすると戻る → 欄を削除すると引き出しに出ない', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '決まった欄ワークスペース');

  // 設定: 作った直後は「受け入れ基準」が1つ。足して、名前を直して、並べ替えられる。10 件までは文で示す
  await openSettings(page);
  const fields = page.getByRole('list', { name: '決まった欄の一覧' });
  await expect(fields.locator('li')).toHaveText([/受け入れ基準/]);
  // 節の説明にも、印が付くという案内は無い
  await expect(page.getByText(/未記入/)).toHaveCount(0);
  await page.getByLabel('新しい決まった欄の名前').fill('影響範囲');
  await page.getByRole('button', { name: '決まった欄を足す' }).click();
  await expect(fields.locator('li')).toHaveText([/受け入れ基準/, /影響範囲/]);
  await expect(page.getByText('決まった欄は 10 件まで足せます（いま 2 件）。')).toBeVisible();
  await fields.getByRole('button', { name: '上へ: 影響範囲' }).click();
  await expect(fields.locator('li')).toHaveText([/影響範囲/, /受け入れ基準/]);

  // 同じ名前は断る
  await page.getByLabel('新しい決まった欄の名前').fill('影響範囲');
  await page.getByRole('button', { name: '決まった欄を足す' }).click();
  await expect(page.getByText('同じ名前の決まった欄があります')).toBeVisible();

  // バックログ: 欄が空の行を作っても、行にも見出しの集計にも「詳細 未記入」は出ない
  await page.locator('.route-tab', { hasText: 'バックログ' }).click();
  await addTaskRow(page, '失効の通知を直す');
  await addTaskRow(page, '履歴の画面を作る');
  const row = page.locator('.entry', { hasText: '失効の通知を直す' });
  await expect(page.locator('.page-head .tally dt')).toHaveText([
    '未完了のタスク',
    '未見積もり',
    'スプリントに入っていない',
  ]);
  await expect(page.locator('#content').getByText(/未記入/)).toHaveCount(0);

  // 引き出し: 欄が設定の並びで出て、どちらも「まだ書かれていません。」。欄の名前に「未記入」の印は添えない
  await row.getByRole('link', { name: '失効の通知を直す' }).click();
  const drawer = page.getByRole('dialog', { name: '失効の通知を直す' });
  const fieldBlocks = drawer.locator('[data-field-id]');
  await expect(fieldBlocks).toHaveCount(2);
  await expect(fieldBlocks.nth(0).locator('.field-label')).toHaveText('影響範囲');
  await expect(fieldBlocks.nth(1).locator('.field-label')).toHaveText('受け入れ基準');
  await expect(fieldBlocks.locator('.doc-box.is-empty')).toHaveText([
    'まだ書かれていません。',
    'まだ書かれていません。',
  ]);
  await expect(drawer.getByText(/未記入/)).toHaveCount(0);

  // Markdown で書くと、値が描かれる
  await drawer.getByRole('button', { name: '影響範囲を書く' }).click();
  await drawer.getByRole('textbox', { name: '影響範囲', exact: true }).fill('- 通知の画面\n- 管理画面');
  await drawer.getByRole('textbox', { name: '影響範囲', exact: true }).blur();
  await expect(fieldBlocks.nth(0).locator('li')).toHaveText(['通知の画面', '管理画面']);
  await drawer.getByRole('button', { name: '受け入れ基準を書く' }).click();
  await drawer.getByRole('textbox', { name: '受け入れ基準', exact: true }).fill('通知が届いたことを確かめた');
  await drawer.getByRole('textbox', { name: '受け入れ基準', exact: true }).blur();
  await expect(fieldBlocks.nth(1)).toContainText('通知が届いたことを確かめた');
  await expect(fieldBlocks.locator('.doc-box.is-empty')).toHaveCount(0);

  // 変更の履歴に欄の名前だけが残る（値の全文は出ない）
  await drawer.getByRole('tab', { name: '変更の履歴' }).click();
  const history = drawer.getByRole('tabpanel', { name: '変更の履歴' });
  await expect(history).toContainText('「受け入れ基準」を書いた');
  await expect(history).toContainText('「影響範囲」を書いた');
  await expect(history).not.toContainText('通知が届いたことを確かめた');

  // 空にして保存すると、「まだ書かれていません。」に戻る
  await drawer.getByRole('button', { name: '受け入れ基準を書き直す' }).click();
  await drawer.getByRole('textbox', { name: '受け入れ基準', exact: true }).fill('');
  await drawer.getByRole('textbox', { name: '受け入れ基準', exact: true }).blur();
  await expect(fieldBlocks.nth(1).locator('.doc-box.is-empty')).toHaveText('まだ書かれていません。');
  await expect(history).toContainText('「受け入れ基準」を空にした');
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();

  // 欄を削除すると、その欄は引き出しに出なくなる。確認の文は、引き出しに出なくなることを伝える
  await openSettings(page);
  await page.getByRole('button', { name: '削除: 受け入れ基準' }).click();
  const confirm = page.getByRole('dialog', { name: '「受け入れ基準」を削除する' });
  await expect(confirm).toContainText('の詳細に出なくなります。元には戻せません');
  await expect(confirm.getByText(/未記入/)).toHaveCount(0);
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(fields.locator('li')).toHaveText([/影響範囲/]);
  await page.locator('.route-tab', { hasText: 'バックログ' }).click();
  await row.getByRole('link', { name: '失効の通知を直す' }).click();
  await expect(fieldBlocks.locator('.field-label')).toHaveText(['影響範囲']);
  // 「同じ名前は断る」で起こした 409 だけが、ブラウザのコンソールに残る
  expect(await collect()).toEqual(['Failed to load resource: the server responded with a status of 409 (Conflict)']);
});

test('同時に直されて断られると、書きかけを残したまま読み直しを促し、読み直した値で書き直せる', async ({ page }) => {
  await createWorkspace(page, '同時に直すワークスペース');
  await addTaskRow(page, '比べる対象');
  await page.locator('.entry', { hasText: '比べる対象' }).getByRole('link', { name: '比べる対象' }).click();
  const drawer = page.getByRole('dialog', { name: '比べる対象' });

  await drawer.getByRole('button', { name: '受け入れ基準を書く' }).click();
  const box = drawer.getByRole('textbox', { name: '受け入れ基準', exact: true });
  await box.fill('自分の下書き');
  // サーバーが「先に別の人が直した」と答える
  const unroute = await failOperation(page, taskFieldSet, AOBA, 409, 'conflict', { details: { reason: 'changed' } });
  await box.blur();
  await expect(drawer.getByRole('alert').filter({ hasText: 'ほかの人が先にこの欄を直しました' })).toBeVisible();
  // 書きかけは残る
  await expect(box).toHaveValue('自分の下書き');
  await unroute();

  // 読み直した値（値なし）を読んだ値として、そのまま書き直せる
  await drawer.getByRole('button', { name: 'もう一度保存する' }).click();
  await expect(drawer.locator('[data-field-id]')).toContainText('自分の下書き');
});

test('計画の画面の先のスプリントとスプリントに入れるダイアログに、欄が空のタスクを入れても未記入の件数が出ない', async ({
  page,
}) => {
  await createWorkspace(page, '計画の欄ワークスペース');
  await addTaskRow(page, '書いていないタスク');

  // 計画の画面でスプリントを作り、欄が空のタスクを入れる
  await page.getByRole('link', { name: '計画', exact: true }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const createDialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  await createDialog.getByLabel('開始日').fill('2027-02-01');
  await createDialog.getByLabel('長さ（日）').fill('14');
  await createDialog.getByLabel('名前（任意）').fill('第1回');
  await createDialog.getByRole('button', { name: '作る' }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.locator('.lane-title')).toHaveText(['第1回']);

  await page.getByRole('button', { name: 'バックログから入れる: スプリント「第1回」' }).click();
  const picker = page.getByRole('dialog', { name: 'スプリント「第1回」に入れる' });
  const list = picker.getByRole('group', { name: '入れるタスク' });
  const checkbox = list.getByRole('checkbox', { name: /^書いていないタスク/ });
  await checkbox.check();
  // 選んだ件数だけを出し、行の読み上げにも未記入を添えない
  await expect(picker.locator('.pick-count')).toHaveText('1 件を選んでいます');
  await expect(picker.getByText(/未記入/)).toHaveCount(0);
  await expect(checkbox).not.toHaveAccessibleName(/未記入/);
  await picker.getByRole('button', { name: '1 件入れる' }).click();
  await expect(picker).toBeHidden();

  // 先のスプリントの .lane-sub は、件数とポイントと未見積もりだけ
  const sub = page.locator('.lane').first().locator('.lane-sub');
  await expect(sub).toContainText('1 件');
  await expect(sub).toContainText('未見積もり 1 件');
  await expect(sub).not.toContainText('未記入');
});
