// エピックの画面（/[slug]/w/[id]/epics/[epicId]）。木のエピックの題から開き、作成者、期日、区分、配下のストーリーを読む。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。
// seed の受託開発チームのエピック「ポイントの交換先を増やす」は、作成者がミナトで、配下のストーリーは完了したタスク1件（2 ポイント）の
// 「送料の割引にポイントを使える」。
// 読むだけで、seed の行は書き換えない（ほかのファイルと並べて走るため）。書き込みはテストで作ったワークスペースの中で行い、
// seed の画面での失敗の扱いは応答を差し替えて確かめる。参加者（討伐隊）、クリア報酬、完了の演出は外した（#1434）
import { epicDetail, epicRequesterUpdate, epicUpdate } from '../src/shared/operations/epic/index.ts';
import { memberList } from '../src/shared/operations/workspace/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { addEpicRow, createWorkspace, openEpicPage, signIn, waitForResponses, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, rewriteOperation } from './operations.ts';
import { seedDueMonthDay } from './seed-dates.ts';

const AOBA = { slug: 'aoba' };
const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const EPIC_TITLE = 'ポイントの交換先を増やす';
const STORY_TITLE = '送料の割引にポイントを使える';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('seed の受託開発チーム: 木のエピックの題から画面が開き、作成者、期日、区分、配下のストーリーが出る。参加者と報酬は出ない', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await page.goto(WORKSPACE);
  await openEpicPage(page, EPIC_TITLE);

  await expect(page).toHaveURL(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page).toHaveTitle(`${EPIC_TITLE} - Banmen`);
  await expect(page.locator('.page-eyebrow')).toHaveText('エピック・追加案件');
  // 概要。本文はエピックの欄
  await expect(page.getByText('貯まったポイントを、送料の割引と提携先の商品券に交換できるようにする。')).toBeVisible();

  // 概要。作成者、期日、区分。クリア報酬の段階と注記は出さない
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dt')).toHaveText(['作成者', '期日', '区分']);
  await expect(request.locator('dd').nth(0)).toContainText('ミナト');
  await expect(request.locator('dd').nth(0)).not.toContainText('離脱済み');
  await expect(request.locator('dd').nth(1)).toContainText(seedDueMonthDay(38));
  await expect(request.locator('dd').nth(2)).toContainText('追加案件');
  await expect(request.locator('.panel-note')).toHaveCount(0);

  // 参加者（討伐隊）の面と、参加する・割り振る・報酬を変える口は無い
  await expect(page.getByRole('region', { name: '参加者' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '参加者' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /参加する|参加をやめる|割り振る|クリア報酬/ })).toHaveCount(0);

  // 配下のストーリー。完了したタスクだけなので、完了 / 全体のポイントが同じ
  const stories = page.getByRole('region', { name: '配下のストーリー' });
  await expect(stories.getByRole('heading', { level: 3, name: STORY_TITLE })).toBeVisible();
  await expect(stories.locator('.progress-num')).toHaveText('2 / 2 pt');
  await expect(stories.getByRole('img', { name: '完了 2 / 2 ポイント' })).toBeVisible();
  // 頭の集計。参加者の人数は出さない
  await expect(page.locator('.tally > div')).toHaveText(['完了のポイント 2', '残りのポイント 0']);

  // リーダーのミナトには、概要の面の下に「作成者を替える」が出る。完了は専用の面にあり（e2e/epic-clear.test.ts）、
  // seed の配下のストーリーは未完了なので押せない。直す口は見出しの横のボタン
  await expect(request.getByRole('button', { name: '作成者を替える' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'エピックを完了にする' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('link', { name: 'エピックを直す' })).toBeVisible();

  // バックログへ戻る
  await page.getByRole('link', { name: 'バックログへ戻る' }).click();
  await expect(page).toHaveURL(WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('作ったワークスペース: 配下の無いエピックは空の案内を出し、作った人が作成者。作成者を替える候補は今の作成者を除く', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'エピック画面のワークスペース');
  await addEpicRow(page, '決済の障害を減らす');
  await openEpicPage(page, '決済の障害を減らす');
  await expect(page.locator('.page-eyebrow')).toHaveText('エピック');
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dt')).toHaveText(['作成者', '期日', '区分']);
  await expect(request.locator('dd').nth(0)).toContainText('ミナト');
  await expect(request.locator('dd').nth(1)).toHaveText('—');
  await expect(request.locator('dd').nth(2)).toHaveText('区分なし');

  const stories = page.getByRole('region', { name: '配下のストーリー' });
  await expect(stories.getByText('ストーリーはまだありません')).toBeVisible();
  await expect(page.locator('.tally > div')).toHaveText(['完了のポイント 0', '残りのポイント 0']);

  // 作成者を替える。作ったワークスペースには今の作成者（ミナト）だけなので、候補は無く、「替える」は押せない
  await request.getByRole('button', { name: '作成者を替える' }).click();
  const requesterDialog = page.getByRole('dialog', { name: '作成者を替える' });
  const noCandidates = '替えられる人がいません。ワークスペースに、今の作成者のほかに所属している人がいません。';
  await expect(requesterDialog.locator('.field-hint')).toHaveText(noCandidates);
  await expect(requesterDialog.getByLabel('新しい作成者').locator('option')).toHaveCount(0);
  await expect(requesterDialog.getByRole('button', { name: '替える' })).toHaveAttribute('aria-disabled', 'true');
  await requesterDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(requesterDialog).toBeHidden();
  await expect(request.getByRole('button', { name: '作成者を替える' })).toBeFocused();
  expect(await collect()).toEqual([]);
});

test('作成者の変更の失敗と成功を、ダイアログとトーストで知らせる（応答を差し替えて確かめる）', async ({ page }) => {
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const request = page.getByRole('region', { name: '概要' });
  const toast = page.locator('.toasts:visible .toast');
  await expect(request.locator('dt')).toHaveText(['作成者', '期日', '区分']);

  // 作成者の候補に、今の作成者（ミナト）は出ない。架空の人を足し、替えられた知らせを出す
  await rewriteOperation(page, memberList, AOBA, (output) => ({
    ...output,
    members: [
      ...output.members,
      {
        id: '019a0000-0000-7000-8000-00000000fff1',
        name: '仮置き 太郎',
        role: 'member' as const,
        joined_on: '2026-10-01',
        avatar_url: null,
      },
    ],
  }));
  await page.reload();
  await request.getByRole('button', { name: '作成者を替える' }).click();
  const dialog = page.getByRole('dialog', { name: '作成者を替える' });
  const select = dialog.getByLabel('新しい作成者');
  await expect(select.locator('option', { hasText: '仮置き 太郎' })).toHaveCount(1);
  await expect(select.locator('option', { hasText: 'ミナト' })).toHaveCount(0);
  await expect(select).toBeFocused();

  // 選んだ人が所属を外れていた（404）。理由を出し、候補を選び直せる
  const unfailRequester = await failOperation(page, epicRequesterUpdate, AOBA, 404, 'not_found');
  await select.selectOption({ label: '仮置き 太郎' });
  await dialog.getByRole('button', { name: '替える' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    '選んだ人はワークスペースに所属していないか、エピックが見つかりません。選び直してください。',
  );
  await expect(select).toBeFocused();
  await unfailRequester();

  // 終わったエピック（409 の epic_finished）と、書き込みの競合に負け続けた（409 の conflict）
  const unfailRequesterFinished = await failOperation(page, epicRequesterUpdate, AOBA, 409, 'epic_finished');
  await dialog.getByRole('button', { name: '替える' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('このエピックは終わっているので、作成者を替えられません');
  await unfailRequesterFinished();
  const unfailRequesterConflict = await failOperation(page, epicRequesterUpdate, AOBA, 409, 'conflict');
  await dialog.getByRole('button', { name: '替える' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('ほかの変更と重なりました。もう一度試してください');
  await unfailRequesterConflict();

  // 替えられた
  await mockOperation(page, epicRequesterUpdate, AOBA, {
    changed: true,
    requester: { id: '019a0000-0000-7000-8000-00000000fff1', name: '仮置き 太郎', left: false },
  });
  await dialog.getByRole('button', { name: '替える' }).click();
  await expect(dialog).toBeHidden();
  await expect(toast.last()).toHaveText('作成者を「仮置き 太郎」に替えました');
});

test('リーダーでない人には「作成者を替える」を出さない（応答を差し替えて確かめる）', async ({ page }) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({ ...output, can_change_requester: false }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dt')).toHaveText(['作成者', '期日', '区分']);
  await expect(request.getByRole('button', { name: '作成者を替える' })).toHaveCount(0);
});

// 離脱済みの本物の行は、DB の seed に置けない（所属の無いユーザーは運用者の指名し直しが物理削除する）。API の確かめは test/epic-detail.test.ts
test('作成者がワークスペースを離れていると、名前に「（離脱済み）」と出る（応答を差し替えて確かめる）', async ({
  page,
}) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    requester: { ...output.requester, left: true },
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const request = page.getByRole('region', { name: '概要' });
  await expect(request.locator('dd').nth(0)).toContainText('ミナト（離脱済み）');
});

test('完了と中止したエピックは、作成者を替える口を出さず、報酬の注記も出さない（応答を差し替えて確かめる）', async ({
  page,
}) => {
  const request = page.getByRole('region', { name: '概要' });
  for (const ended of [{ completed_at: '2026-10-22T00:00:00.000Z' }, { canceled_at: '2026-10-22T00:00:00.000Z' }]) {
    await page.unrouteAll();
    await rewriteOperation(page, epicDetail, AOBA, (output) => ({ ...output, epic: { ...output.epic, ...ended } }));
    await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
    await expect(request.locator('dt')).toHaveText(['作成者', '期日', '区分']);
    await expect(request.getByRole('button')).toHaveCount(0);
    await expect(request.locator('.panel-note')).toHaveCount(0);
  }
});

test('直した後の読み直しが失敗したら、前の値を残して知らせだけを出す', async ({ page }) => {
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await page.getByRole('link', { name: 'エピックを直す' }).click();
  const drawer = page.getByRole('dialog', { name: EPIC_TITLE, exact: true });
  await expect(drawer.getByRole('button', { name: '本文を書く' })).toBeVisible();
  // 保存は通さず（seed を書き換えない）、読み直しだけが失敗する形にする
  await mockOperation(page, epicUpdate, AOBA, {
    epic: {
      id: EPIC_ID,
      title: EPIC_TITLE,
      body_md: '読み直しに失敗する本文',
      due_on: null,
      link_url: null,
      category_id: null,
    },
  });
  await failOperation(page, epicDetail, AOBA, 500, 'internal');
  const saved = waitForResponses(page, '/epic-update');
  await drawer.getByRole('button', { name: '本文を書く' }).click();
  const body = drawer.getByRole('textbox', { name: '本文' });
  await body.fill('読み直しに失敗する本文');
  await body.blur();
  await saved;
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('alert').filter({ hasText: '最新の内容を読み込めませんでした' })).toBeVisible();
  // 画面は読み込みの失敗に替わらず、前の値のまま
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page.getByRole('region', { name: '配下のストーリー' }).locator('.story-block')).toHaveCount(1);
});

// 保存の応答の直後に閉じると、閉じる移動の途中に読み直しが始まることがある。移動が決着してから読み直すので、
// 画面は保存した後の値に替わる（移動の途中に始めた読み直しは SvelteKit が捨てる。#1331）。
// 閉じる移動は load を走らせず一瞬で終わるので、この順を e2e で決まって作ることはできない。順は src/lib/navigation-settled.test.ts が確かめる
test('直した直後に閉じても、画面は保存した後の値を読み直す', async ({ page }) => {
  const savedBody = '閉じた直後にも読み直す本文';
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await page.getByRole('link', { name: 'エピックを直す' }).click();
  const drawer = page.getByRole('dialog', { name: EPIC_TITLE, exact: true });
  await expect(drawer.getByRole('button', { name: '本文を書く' })).toBeVisible();
  // 保存は通さず（seed を書き換えない）、読み直しが保存した後の本文を返す形にする
  await mockOperation(page, epicUpdate, AOBA, {
    epic: {
      id: EPIC_ID,
      title: EPIC_TITLE,
      body_md: savedBody,
      due_on: null,
      link_url: null,
      category_id: null,
    },
  });
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    epic: { ...output.epic, body_md: savedBody },
  }));
  const saved = waitForResponses(page, '/epic-update');
  await drawer.getByRole('button', { name: '本文を書く' }).click();
  const body = drawer.getByRole('textbox', { name: '本文' });
  await body.fill(savedBody);
  await body.blur();
  await saved;
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByText(savedBody)).toBeVisible();
  await expect(page.getByText('貯まったポイントを、送料の割引と提携先の商品券に交換できるようにする。')).toHaveCount(0);
  // 読み直しは通ったので、読み直しの失敗の知らせは出さない
  await expect(page.getByRole('alert').filter({ hasText: '最新の内容を読み込めませんでした' })).toHaveCount(0);
});

test('終了したワークスペースでも読めて、直す口と作成者を替える口と完了の操作は出さない', async ({ page }) => {
  await rewriteOperation(page, workspaceInfo, AOBA, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible();
  await expect(page.getByRole('region', { name: '配下のストーリー' }).locator('.story-block')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'エピックを直す' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '概要' }).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'エピックを完了にする' })).toHaveCount(0);
});

test('無いエピック（別のワークスペース、存在しない ID、形の合わない ID）は、見つからない画面とバックログへ戻るリンクを出す', async ({
  page,
}) => {
  for (const id of ['019a0000-0000-7000-8000-00000000ffff', 'not-an-id']) {
    await page.goto(`${WORKSPACE}/epics/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'エピックが見つかりません' })).toBeVisible();
    await expect(page.getByText('削除されたか、このワークスペースにないエピックです。')).toBeVisible();
    await page.getByRole('link', { name: 'バックログへ戻る' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  }
});

test('読み込めなかったときは失敗の画面と「もう一度試す」を出す', async ({ page }) => {
  await failOperation(page, epicDetail, AOBA, 500, 'internal');
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByText('読み込めませんでした').first()).toBeVisible();
  const retry = page.getByRole('button', { name: 'もう一度試す' });
  await expect(retry).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toHaveCount(0);
});
