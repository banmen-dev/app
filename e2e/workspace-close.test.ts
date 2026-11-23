// ワークスペースを終了する、再開する。管理者が終了する（確認のダイアログを経る）→ 帯を確かめる → 再開する。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。
// 終了して確かめるワークスペースは、管理の画面から作った専用のもの（seed のワークスペースを終了したままにしない）。
// 作ったワークスペースは消せずに残るので、名前に繰り返し（--repeat-each）とやり直しの回を混ぜ、前の回の行に当たらないようにする
import type { Page } from '@playwright/test';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import {
  workspaceClose,
  workspaceInfo,
  workspaceList,
  workspaceReopen,
} from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import { expectFocusReturned, signIn, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, routeOperation, rewriteOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const BANNER = /\d{4}-\d{2}-\d{2} に終了しました。読み取り専用です。/;

// 終了した帯。ストーリーとタスクの引き出しも終了したワークスペースの案内に .callout を持つので、帯の文で絞る
function bannerOf(page: Page) {
  return page.locator('.callout', { hasText: 'に終了しました。読み取り専用です。' });
}

// 管理の画面のワークスペースの節。変更の履歴の節も表を持ち、ワークスペースの名前の行が出るので、節で絞る
function workspacesOf(page: Page) {
  return page.getByRole('region', { name: 'ワークスペース', exact: true });
}

// この回の印。作る行の名前に混ぜる
function runMark(): string {
  return `${test.info().repeatEachIndex}-${test.info().retry}`;
}

// 管理の画面からワークスペースを作る。リーダーの既定は自分。完了の表示で「開く」を押して、そのワークスペースの画面へ移る
async function createWorkspace(page: Page, name: string, leader?: string): Promise<string> {
  await page.goto('/aoba/admin');
  await page.getByRole('button', { name: 'ワークスペースを作る' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'ワークスペースを作る' });
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByLabel('名前').fill(name);
  if (leader !== undefined) await dialog.getByRole('combobox').selectOption({ label: leader });
  await dialog.getByRole('button', { name: '作る' }).click();
  await page.getByRole('dialog', { name: 'ワークスペースを作りました' }).getByRole('button', { name: '開く' }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
  return page.url();
}

test.describe('管理者（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('確認のダイアログを経て終了し、帯と読み取り専用を確かめ、再開すると元に戻る', async ({ page }) => {
    const collect = await watchViolations(page);
    const name = `終了確認ワークスペース ${runMark()}`;
    const workspaceUrl = await createWorkspace(page, name);
    // 進行中のうちは帯が無く、タスクの空の行で作れる
    await expect(bannerOf(page)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'タスクを足す', exact: true })).toBeVisible();

    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });
    const closeButton = row.getByRole('button', { name: `「${name}」を終了する` });
    await expect(closeButton).toHaveText('終了する');
    await closeButton.click();

    // 確認のダイアログ。読み取り専用になることと、再開できることを書く。危険の色にはしない
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    await expect(dialog).toContainText('読み取り専用');
    await expect(dialog).toContainText('再開はこの画面から行えます');
    await expect(dialog).not.toContainText('自分用');
    await expect(dialog).not.toContainText('いつでも');
    // 対象のワークスペースの名前だけを埋める
    await expect(dialog).not.toContainText('{');
    await expect(dialog.locator('.is-danger')).toHaveCount(0);
    // やめれば何も起きない
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, closeButton);
    await expect(row.locator('.chip')).toHaveCount(0);

    await closeButton.click();
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'ワークスペースを終了しました' })).toBeVisible();
    // 一覧を読み直して、終了の印と「再開する」に替わる。押したボタンは残り、フォーカスを保つ
    await expect(row.locator('.chip')).toHaveText(/^終了 \d{4}-\d{2}-\d{2}$/);
    const reopenButton = row.getByRole('button', { name: `「${name}」を再開する` });
    await expect(reopenButton).toHaveText('再開する');
    await expect(reopenButton).toBeFocused();
    // 見出しの集計は進行中のワークスペースの数
    await expect(page.locator('.tally')).toContainText('進行中のワークスペース');

    // 終了したワークスペースの画面: どの画面にも帯が出て、タスクの空の行は出ない。管理者には設定の再開操作へのリンクが付く
    await page.goto(workspaceUrl);
    const banner = bannerOf(page);
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText(BANNER);
    // リンクは本文と同じ色（既定のリンクの青にしない）で、下線を引く
    const link = banner.getByRole('link', { name: '設定で再開する' });
    const colors = await banner.evaluate((el) => [
      getComputedStyle(el.querySelector('a')!).color,
      getComputedStyle(el.querySelector('span')!).color,
    ]);
    expect(colors[0]).toBe(colors[1]);
    await expect(link).toHaveCSS('text-decoration-line', 'underline');
    await expect(banner.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'タスクを足す', exact: true })).toHaveCount(0);
    // 見出しの右上の「終了 <日>」の印は、帯と重なるので出さない
    await expect(page.locator('.page-head .chip')).toHaveCount(0);
    await expect(link).toHaveAttribute('href', /\/settings#workspace-state$/);

    // 組織の管理からも引き続き再開できる
    await page.goto('/aoba/admin');
    // 再開する。確認なしで送り、一覧が読み直される
    await row.getByRole('button', { name: `「${name}」を再開する` }).click();
    await expect(page.getByRole('status').filter({ hasText: 'ワークスペースを再開しました' })).toBeVisible();
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(row.getByRole('button', { name: `「${name}」を終了する` })).toHaveText('終了する');

    await page.goto(workspaceUrl);
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(bannerOf(page)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'タスクを足す', exact: true })).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('所属していない管理者が設定で終了・再開でき、リーダーの設定には操作が出ない', async ({
    page,
    context,
    baseURL,
  }) => {
    const name = `設定から終了するワークスペース ${runMark()}`;
    const workspaceUrl = await createWorkspace(page, name, 'ハルカ');
    const settingsUrl = `${workspaceUrl}/settings`;
    await page.goto(settingsUrl);
    const section = page.getByRole('region', { name: 'ワークスペースの利用状態' });
    const close = section.getByRole('button', { name: `「${name}」を終了する` });
    const reopen = section.getByRole('button', { name: `「${name}」を再開する` });
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    const markdown = page.getByRole('textbox', { name: 'Markdown', exact: true });
    await markdown.fill('保存していない完成の定義');
    await expect(close).toHaveAttribute('aria-disabled', 'true');
    await expect(section.getByText(/書きかけの設定/)).toBeVisible();
    await close.click({ force: true });
    await expect(dialog).toBeHidden();
    await expect(markdown).toHaveValue('保存していない完成の定義');
    await markdown.clear();

    await close.click();
    await expect(dialog).toContainText('外部サービスとの同期が止まります');
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(close).toBeFocused();
    await expect(bannerOf(page)).toHaveCount(0);

    await close.click();
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    await expect(page).toHaveURL(settingsUrl);
    await expect(bannerOf(page)).toContainText(BANNER);
    await expect(reopen).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveCount(0);

    await page.goto(workspaceUrl);
    await expect(page.getByRole('textbox', { name: 'タスクを足す', exact: true })).toHaveCount(0);
    await bannerOf(page).getByRole('link', { name: '設定で再開する' }).click();
    await expect(page).toHaveURL(`${settingsUrl}#workspace-state`);
    await reopen.click();
    await expect(bannerOf(page)).toHaveCount(0);
    await expect(close).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Markdown', exact: true })).toBeVisible();

    await page.goto('/aoba/admin');
    const history = page.getByRole('region', { name: '変更の履歴', exact: true });
    await expect(history.getByText(`ワークスペース「${name}」を終了しました`, { exact: true })).toHaveCount(1);
    await expect(history.getByText(`ワークスペース「${name}」を再開しました`, { exact: true })).toHaveCount(1);

    await signIn(context, baseURL, 'member');
    await page.goto(settingsUrl);
    await expect(page.getByRole('textbox', { name: 'Markdown', exact: true })).toBeVisible();
    await expect(section).toHaveCount(0);
  });

  test('終了後に利用状態を読み直せなければ操作を止め、再試行で再開できる', async ({ page }) => {
    const name = `終了後に読み直すワークスペース ${runMark()}`;
    const workspaceUrl = await createWorkspace(page, name);
    await page.goto(`${workspaceUrl}/settings`);
    const section = page.getByRole('region', { name: 'ワークスペースの利用状態' });
    const close = section.getByRole('button', { name: `「${name}」を終了する` });
    await close.click();
    const readResponse = Promise.withResolvers<void>();
    const removeFailure = await routeOperation(page, workspaceInfo, { slug: 'aoba' }, async (call) => {
      await readResponse.promise;
      await call.fail(500, 'internal');
    });
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    const markdown = page.getByRole('textbox', { name: 'Markdown', exact: true });
    try {
      await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
      await expect(dialog).toBeHidden();
      await expect(close).toHaveAttribute('aria-disabled', 'true');
      await expect(markdown).toHaveCount(0);
    } finally {
      readResponse.resolve();
    }
    await expect(section.getByRole('alert')).toContainText('利用状態を読み直せませんでした');
    await expect(close).toHaveAttribute('aria-disabled', 'true');
    await expect(markdown).toHaveCount(0);

    await removeFailure();
    await section.getByRole('button', { name: 'もう一度試す' }).click();
    const reopen = section.getByRole('button', { name: `「${name}」を再開する` });
    await expect(reopen).toBeFocused();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(bannerOf(page)).toContainText(BANNER);
    await reopen.click();
    await expect(close).toBeVisible();
    await expect(bannerOf(page)).toHaveCount(0);
  });

  test('設定からの再開が人数の上限で断られたら理由を残し、同時に再開されていたら状態を読み直す', async ({ page }) => {
    const workspaceUrl = '/aoba/w/019a0000-0000-7000-8000-000000000401/settings';
    let closedAt: string | null = '2026-10-22T00:00:00.000Z';
    await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (data) => ({ ...data, closed_at: closedAt }));
    const removeLimit = await failOperation(page, workspaceReopen, { slug: 'aoba' }, 409, 'member_limit_reached', {
      details: { adding: 2, used: 5, limit: 6 },
    });
    await page.goto(workspaceUrl);
    const section = page.getByRole('region', { name: 'ワークスペースの利用状態' });
    const reopen = section.getByRole('button', { name: '「受託開発チーム」を再開する' });
    await reopen.click();
    await expect(section.getByRole('alert')).toContainText('上限の 6');
    await expect(page.getByRole('status').filter({ hasText: 'ワークスペースを再開しました' })).toHaveCount(0);
    await expect(bannerOf(page)).toContainText(BANNER);

    await removeLimit();
    await routeOperation(page, workspaceReopen, { slug: 'aoba' }, (call) => {
      closedAt = null;
      return call.fail(409, 'conflict');
    });
    await reopen.click();
    await expect(section.getByRole('button', { name: '「受託開発チーム」を終了する' })).toBeVisible();
    await expect(bannerOf(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '状態が変わっていました' })).toBeVisible();
  });

  test('送っている間は、「終了する」を押しても無視し、ダイアログも閉じられず、1回しか送らない', async ({ page }) => {
    const name = `二重送信の確認ワークスペース ${runMark()}`;
    await createWorkspace(page, name);
    let requests = 0;
    await routeOperation(page, workspaceClose, { slug: 'aoba' }, async (call) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await call.passThrough();
    });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });
    await row.getByRole('button', { name: `「${name}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();

    // disabled でなく aria-disabled。押しても何も起きない
    const submitting = dialog.getByRole('button', { name: '終了しています' });
    await expect(submitting).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('status')).toHaveText('終了しています');
    await submitting.click({ force: true });
    await submitting.click({ force: true });
    await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    await expect(dialog).toBeHidden();
    await expect(row.locator('.chip')).toHaveText(/^終了 /);
    expect(requests).toBe(1);

    // 後片づけ。再開しておく
    await row.getByRole('button', { name: `「${name}」を再開する` }).click();
    await expect(row.locator('.chip')).toHaveCount(0);
  });

  test('終了できなかったときは、ダイアログの中に理由を出して開いたままにする。別の画面で先に終了されていたら、読み直して知らせる', async ({
    page,
  }) => {
    const name = `失敗の確認ワークスペース ${runMark()}`;
    await createWorkspace(page, name);
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });

    const removeFailure = await failOperation(page, workspaceClose, { slug: 'aoba' }, 500, 'internal', {
      message: 'x',
    });
    await row.getByRole('button', { name: `「${name}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'ワークスペースを終了できませんでした。もう一度試してください。',
    );
    await expect(dialog.getByRole('button', { name: `「${name}」を終了する` })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await expect(row.locator('.chip')).toHaveCount(0);

    // 別の画面で先に終了されていた（409）
    await removeFailure();
    const removeConcurrentClose = await routeOperation(page, workspaceClose, { slug: 'aoba' }, async (call) => {
      await page.request.post('/api/aoba/workspace-close', {
        headers: { Origin: new URL(page.url()).origin },
        data: call.input,
      });
      await call.passThrough();
    });
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    // 終了し直されたのか、再開されたのかは言い切らない
    await expect(page.getByRole('status').filter({ hasText: `「${name}」の状態が変わっていました` })).toBeVisible();
    await expect(row.locator('.chip')).toHaveText(/^終了 /);

    await removeConcurrentClose();
    await row.getByRole('button', { name: `「${name}」を再開する` }).click();
    await expect(row.locator('.chip')).toHaveCount(0);
  });

  // 受託開発チームを、一覧の上だけで終了した状態にする（seed のワークスペースを終了しない）。操作は route で差し替える
  const SEED_NAME = '受託開発チーム';
  async function showSeedWorkspaceClosed(page: Page, onList: (call: number) => 'real' | 'fail') {
    let calls = 0;
    await routeOperation(page, workspaceList, { slug: 'aoba' }, async (call) => {
      calls++;
      if (onList(calls) === 'fail') {
        return call.fail(500, 'internal', { message: 'x' });
      }
      const body = await call.fetch();
      for (const workspace of body.workspaces) {
        if (workspace.name === SEED_NAME) workspace.closed_at = '2026-10-22T00:00:00.000Z';
      }
      return call.fulfill(body);
    });
    return () => calls;
  }

  test('390px の幅では、行を縦に積み、操作は横にはみ出さずに見える', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/aoba/admin');
    const button = page
      .locator('tbody tr', { hasText: SEED_NAME })
      .getByRole('button', { name: `「${SEED_NAME}」を終了する` });
    await expect(button).toBeAttached();
    // 760px 以下は列をやめて積むので、表は横にはみ出さず、操作の列を固定する必要が無い（#462）
    const overflow = await workspacesOf(page)
      .locator('.table-wrap')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // 縦には、その行まで動かす。横には動かさずに見える
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    // 押す所は 44px 以上
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });

  test('空白の無い長い名前でも、確認の見出しとトーストは折り返してはみ出さない', async ({ page }) => {
    // 名前の上限（50字）いっぱいに、空白を入れずに回の印を末尾に付ける
    const mark = runMark().replace('-', 'x');
    const name = `${'W'.repeat(50 - mark.length)}${mark}`;
    await createWorkspace(page, name);
    await page.setViewportSize({ width: 390, height: 800 });
    await failOperation(page, workspaceClose, { slug: 'aoba' }, 404, 'not_found', { message: 'x' });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });
    await row.getByRole('button', { name: `「${name}」を終了する` }).scrollIntoViewIfNeeded();
    await row.getByRole('button', { name: `「${name}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    const overflow = (selector: string) => dialog.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(await overflow('.dialog-title')).toBeLessThanOrEqual(0);
    expect(await overflow('.dialog-sheet')).toBeLessThanOrEqual(0);

    // 404 のトースト（名前入り）も、はみ出さない
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    const toast = page.getByRole('status').filter({ hasText: `「${name}」を操作できませんでした` });
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await toast.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
  });

  test('終了の確認で 404 を受けたら、理由を出してダイアログを閉じ、一覧を読み直す', async ({ page }) => {
    await failOperation(page, workspaceClose, { slug: 'aoba' }, 404, 'not_found', { message: 'x' });
    let listCalls = 0;
    await routeOperation(page, workspaceList, { slug: 'aoba' }, (call) => {
      listCalls++;
      return call.passThrough();
    });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${SEED_NAME}」を終了しますか？` });
    await dialog.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: `「${SEED_NAME}」を操作できませんでした` })).toBeVisible();
    await expect.poll(() => listCalls).toBe(2);
  });

  test('再開が 409 の conflict になったら、状態が変わっていたことを知らせて読み直す', async ({ page }) => {
    const listCalls = await showSeedWorkspaceClosed(page, () => 'real');
    await failOperation(page, workspaceReopen, { slug: 'aoba' }, 409, 'conflict', { message: 'x' });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    // 「すでに開いています」とは言い切らない（終了し直された場合もある）
    await expect(
      page.getByRole('status').filter({ hasText: `「${SEED_NAME}」の状態が変わっていました` }),
    ).toBeVisible();
    await expect(page.getByText('すでに開いています')).toHaveCount(0);
    await expect.poll(listCalls).toBe(2);
  });

  // 人数の上限で断られた理由は、4秒で消えるトーストでなく、表の上の消えないコールアウトに出す
  function refusalOf(page: Page) {
    return workspacesOf(page).locator('.callout.is-warn[role="alert"]', {
      hasText: `「${SEED_NAME}」は再開できません`,
    });
  }

  for (const width of [320, 390, 1024, 1280]) {
    test(`${width}px: 再開が個数上限で断られると、利用中の数と枠を空ける方法が残り、再試行できる`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const listCalls = await showSeedWorkspaceClosed(page, () => 'real');
      const removeRefusal = await failOperation(
        page,
        workspaceReopen,
        { slug: 'aoba' },
        409,
        'workspace_limit_reached',
        { message: 'x', details: { used: 3, limit: 3 } },
      );
      await page.goto('/aoba/admin');
      const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
      const button = row.getByRole('button', { name: `「${SEED_NAME}」を再開する` });
      await button.click();
      const refusal = refusalOf(page);
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText('利用中のものを3個まで使えます（今3個）');
      await expect(refusal).toContainText('この一覧で今あるワークスペースを終了して枠を空けてください');
      await expect(refusal).not.toContainText('組織の管理');
      await expect.poll(listCalls).toBe(2);
      await expect(row.locator('.chip')).toContainText('終了');
      await expect(button).toBeFocused();
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      expect(await refusal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // 空きができた後の再試行を成功として返す。次の再開で理由が消える。
      await removeRefusal();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await routeOperation(page, workspaceReopen, { slug: 'aoba' }, async (call) => {
        await pending;
        await call.fulfill({ workspace_id: 'reopened' });
      });
      await button.click();
      try {
        await expect(refusal).toHaveCount(0);
        await expect(button).toHaveAttribute('aria-disabled', 'true');
      } finally {
        release();
      }
      await expect(page.getByRole('status').filter({ hasText: 'ワークスペースを再開しました' })).toBeVisible();
    });
  }

  test('再開の個数上限に details が無いときも、利用中の上限と枠を空ける方法を示す', async ({ page }) => {
    await showSeedWorkspaceClosed(page, () => 'real');
    await failOperation(page, workspaceReopen, { slug: 'aoba' }, 409, 'workspace_limit_reached', { message: 'x' });
    await page.goto('/aoba/admin');
    await workspacesOf(page)
      .locator('tbody tr', { hasText: SEED_NAME })
      .getByRole('button', { name: `「${SEED_NAME}」を再開する` })
      .click();
    await expect(refusalOf(page)).toContainText('利用中の個数が上限に達しています');
    await expect(refusalOf(page)).toContainText('この一覧で今あるワークスペースを終了して枠を空けてください');
    await expect(refusalOf(page)).not.toContainText('{');
  });

  test('再開が 409 の member_limit_reached になったら、増える人数と今の人数、上限、対処を表の上に残して読み直す', async ({
    page,
  }) => {
    const listCalls = await showSeedWorkspaceClosed(page, () => 'real');
    const removeRefusal = await failOperation(page, workspaceReopen, { slug: 'aoba' }, 409, 'member_limit_reached', {
      message: 'x',
      details: { used: 14, limit: 15, adding: 2 },
    });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    const refusal = refusalOf(page);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('承諾待ちの招待の 2 人が組織の人数に加わり');
    await expect(refusal).toContainText('今の 14 人と合わせて上限の 15 人を超えます');
    // 対処は、上限の見直し（運用者に問い合わせる）と、ほかのユーザーを無効にすることだけ。閉じたワークスペースの招待は取り消せない
    await expect(refusal).toContainText('上限の見直しは運用者に問い合わせてください');
    await expect(refusal).toContainText('組織の管理の「ユーザー」で、ほかのユーザーを無効にして人数を減らしてください');
    await expect(refusal).toContainText('有効に戻しても所属は戻りません');
    await expect(refusal).not.toContainText('取り消');
    await expect(refusal).not.toContainText('{');
    // 表の上にある。汎用の失敗の文言には落とさない
    const aboveTable = await refusal.evaluate(
      (el) =>
        (el.compareDocumentPosition(el.parentElement!.querySelector('table')!) & Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    );
    expect(aboveTable).toBe(true);
    await expect(page.getByText('を再開できませんでした')).toHaveCount(0);
    // 一覧を読み直した後も、トーストが消える時間を過ぎても残る
    await expect.poll(listCalls).toBe(2);
    await page.waitForTimeout(5000);
    await expect(refusal).toBeVisible();

    // 次に「再開する」を押すと消える（成功すれば、そのままトーストで知らせる）
    await removeRefusal();
    await mockOperation(
      page,
      workspaceReopen,
      { slug: 'aoba' },
      { workspace_id: '019a0000-0000-7000-8000-000000000401' },
    );
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();
    await expect(refusal).toHaveCount(0);
  });

  test('details の無い 409 の member_limit_reached は、数なしの理由を同じ場所に残して読み直す', async ({ page }) => {
    const listCalls = await showSeedWorkspaceClosed(page, () => 'real');
    await failOperation(page, workspaceReopen, { slug: 'aoba' }, 409, 'member_limit_reached', { message: 'x' });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    const refusal = refusalOf(page);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('承諾待ちの招待を含めると、組織の人数が上限を超えます');
    await expect(refusal).toContainText('上限の見直しは運用者に問い合わせてください');
    await expect(refusal).toContainText('ほかのユーザーを無効にして人数を減らしてください');
    // 数の穴を残さない。汎用の失敗の文言にも落とさない
    for (const leaked of ['人が', '{', 'undefined', 'NaN']) await expect(refusal).not.toContainText(leaked);
    await expect(page.getByText('を再開できませんでした')).toHaveCount(0);
    await expect.poll(listCalls).toBe(2);
    await expect(refusal).toBeVisible();
  });

  test('空白の無い長い名前でも、断った理由は折り返してはみ出さず、画面の中に入る', async ({ page }) => {
    // 名前の上限（50字）いっぱいに、空白を入れない
    const longName = 'W'.repeat(50);
    await page.setViewportSize({ width: 390, height: 800 });
    await rewriteOperation(page, workspaceList, { slug: 'aoba' }, (body) => {
      for (const workspace of body.workspaces) {
        if (workspace.name === SEED_NAME)
          Object.assign(workspace, { name: longName, closed_at: '2026-10-22T00:00:00.000Z' });
      }
      return body;
    });
    await failOperation(page, workspaceReopen, { slug: 'aoba' }, 409, 'member_limit_reached', {
      message: 'x',
      details: { used: 14, limit: 15, adding: 2 },
    });
    await page.goto('/aoba/admin');
    const button = workspacesOf(page)
      .locator('tbody tr', { hasText: longName })
      .getByRole('button', { name: `「${longName}」を再開する` });
    await button.scrollIntoViewIfNeeded();
    await button.click();

    const refusal = workspacesOf(page).locator('.callout.is-warn[role="alert"]', {
      hasText: `「${longName}」は再開できません`,
    });
    await expect(refusal).toBeVisible();
    expect(await refusal.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await refusal.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
    // 押した行が下にあっても、理由が画面の中に入る
    await expect(refusal).toBeInViewport();
  });

  test('操作の後の読み直しに失敗したら、一覧を残したまま知らせ、「もう一度試す」で読み直せる', async ({ page }) => {
    // 2回目（操作の後の読み直し）だけ失敗させる
    await showSeedWorkspaceClosed(page, (call) => (call === 2 ? 'fail' : 'real'));
    await mockOperation(
      page,
      workspaceReopen,
      { slug: 'aoba' },
      { workspace_id: '019a0000-0000-7000-8000-000000000401' },
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    const notice = page.locator('.callout', { hasText: 'ワークスペースの一覧を更新できませんでした' });
    await expect(notice.getByRole('alert')).toHaveText('ワークスペースの一覧を更新できませんでした');
    // 知らせ（alert）と状態（status）は入れ子にしない
    await expect(notice.locator('[role="alert"] [role="status"]')).toHaveCount(0);
    // 今の一覧は残る
    await expect(row).toBeVisible();
    await notice.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(notice).toHaveCount(0);
    await expect(row).toBeVisible();
    // 押したボタンが消えるので、節の中身へフォーカスが移る
    await expect(workspacesOf(page).locator('.setting-body[tabindex="-1"]')).toBeFocused();
  });

  test('「もう一度試す」を押していない読み込みの結果では、「まだ読み込めませんでした」を出さない', async ({ page }) => {
    // 2、3、5 回目を失敗させる: 操作の後の読み直しが失敗 → 「もう一度試す」も失敗 → 別の操作の読み直しが成功 → また別の操作の読み直しが失敗
    await showSeedWorkspaceClosed(page, (call) => ([2, 3, 5].includes(call) ? 'fail' : 'real'));
    await mockOperation(
      page,
      workspaceReopen,
      { slug: 'aoba' },
      { workspace_id: '019a0000-0000-7000-8000-000000000401' },
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    const reopen = row.getByRole('button', { name: `「${SEED_NAME}」を再開する` });
    const notice = page.locator('.callout', { hasText: 'ワークスペースの一覧を更新できませんでした' });

    await reopen.click();
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(notice.getByRole('status')).toHaveText('まだ読み込めませんでした');

    // 押していない読み込み（操作の後の読み直し）が成功すると、知らせごと消える
    await reopen.click();
    await expect(notice).toHaveCount(0);
    // その次の読み直しが失敗しても、押していないので「まだ」とは出ない
    await reopen.click();
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('status')).toHaveText('');
  });

  test('先に始めた読み直しが後で返っても、新しい一覧を古い一覧で上書きしない', async ({ page }) => {
    // 2回目（1回目の操作の後の読み直し）は遅らせ、古い一覧（終了した）を返す。3回目（2回目の操作の後）は本物の一覧（進行中）を先に返す
    let calls = 0;
    let staleDone: () => void = () => {};
    const staleSent = new Promise<void>((resolve) => (staleDone = resolve));
    await routeOperation(page, workspaceList, { slug: 'aoba' }, async (call) => {
      calls++;
      if (calls !== 2) return call.passThrough();
      const body = await call.fetch();
      for (const workspace of body.workspaces) {
        if (workspace.name === SEED_NAME) workspace.closed_at = '2026-10-22T00:00:00.000Z';
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await call.fulfill(body);
      staleDone();
    });
    await mockOperation(
      page,
      workspaceClose,
      { slug: 'aoba' },
      { workspace_id: '019a0000-0000-7000-8000-000000000401', closed_at: '2026-10-26T00:00:00.000Z' },
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    const close = row.getByRole('button', { name: `「${SEED_NAME}」を終了する` });
    const dialog = page.getByRole('dialog', { name: `「${SEED_NAME}」を終了しますか？` });

    // 1回目の終了する: 読み直し（2回目）が遅れている間に、2回目の終了する（読み直しは3回目）を済ませる
    await close.click();
    await dialog.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    await close.click();
    await dialog.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => calls).toBe(3);

    // 遅れた古い一覧が返った後も、新しい一覧（進行中）のまま
    await staleSent;
    await page.waitForTimeout(300);
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(close).toBeVisible();
  });

  test('一覧を読み込めないときは節の中に知らせ、「もう一度試す」で読み直せる。ほかの部分は出る', async ({ page }) => {
    let calls = 0;
    await routeOperation(page, workspaceList, { slug: 'aoba' }, (call) => {
      calls++;
      if (calls === 1) return call.fail(500, 'internal', { message: 'x' });
      return call.passThrough();
    });
    await page.goto('/aoba/admin');
    // 見出しと節の見出しは出ている
    await expect(page.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();
    // 「ワークスペースを作る」などと分けるため、名前は完全に一致させる
    await expect(page.getByRole('heading', { level: 2, name: 'ワークスペース', exact: true })).toBeVisible();
    await expect(page.getByText('ワークスペースの一覧を読み込めませんでした')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ワークスペースを作る' })).toBeVisible();

    await page.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(workspacesOf(page).locator('tbody tr', { hasText: '受託開発チーム' })).toBeVisible();
    await expect(page.getByText('ワークスペースの一覧を読み込めませんでした')).toHaveCount(0);
  });

  test('初回の読み込み中は、空の読み上げの領域を先に描き、後から文字を入れる', async ({ page }) => {
    // 節の読み上げの領域（data-section-status）が DOM に入ったときと、中の文字が変わったときを順に記録する。
    // 領域と文字が同じ描画で入ると読み上げられないことがあるので、空の領域が先で、文字が後であることを見る
    await page.addInitScript(() => {
      const log: string[] = [];
      (window as unknown as { __sectionStatusLog: string[] }).__sectionStatusLog = log;
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          // 領域は節ごとまとめて DOM に入るので、足された要素の中も探す
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            const added = node.matches('[data-section-status]')
              ? [node]
              : node.querySelectorAll('[data-section-status]');
            for (const region of added) log.push(`added:${region.textContent}`);
          }
          const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
          const region = target?.closest('[data-section-status]');
          if (region) log.push(`text:${region.textContent}`);
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await routeOperation(page, workspaceList, { slug: 'aoba' }, async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await call.passThrough();
    });
    await page.goto('/aoba/admin', { waitUntil: 'commit' });
    // ワークスペースの節の領域（ほかの節も同じ領域を持つ）
    const region = page.getByRole('region', { name: 'ワークスペース', exact: true }).locator('[data-section-status]');
    await expect(region).toHaveText('読み込んでいます');
    const log = await page.evaluate(() => (window as unknown as { __sectionStatusLog: string[] }).__sectionStatusLog);
    expect(log[0]).toBe('added:');
    expect(log.indexOf('text:読み込んでいます')).toBeGreaterThan(0);
    // 読めたら、領域は残したまま文字を消す
    await expect(workspacesOf(page).locator('tbody tr', { hasText: '受託開発チーム' })).toBeVisible();
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText('');
  });

  test('狭い幅でも、節の「もう一度試す」は押せる範囲が 44px 四方以上ある', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await failOperation(page, workspaceList, { slug: 'aoba' }, 500, 'internal', { message: 'x' });
    await page.goto('/aoba/admin');
    const retry = page.getByRole('button', { name: 'もう一度試す' });
    await expect(retry).toBeVisible();
    // 見た目の大きさは変えず、::after で押せる範囲だけを広げる（横のヒントの文字を上にずらさないため）
    const hit = await retry.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return { width: parseFloat(after.width), height: parseFloat(after.height), position: after.position };
    });
    expect(hit.position).toBe('absolute');
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    expect((await retry.boundingBox())!.height).toBeLessThan(44);
  });
});

test.describe('管理者がワークスペース1つにだけ所属している組織（ホームのワークスペースの面）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  const workspace = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };

  // 終了の状態は画面の上だけで持ち、組織の枠の応答（organization）と管理の一覧（workspace-list）に同じ状態を返す（seed を終了したままにしない）。
  // closedAt を書き換えると、次の読み込みの応答が変わる
  async function routeState(page: Page, initial: string | null) {
    const state = { closedAt: initial };
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
      ...output,
      organization: { ...output.organization, has_workspaces: true },
      workspaces: [{ ...workspace, role: 'leader' as const, closed_at: state.closedAt }],
    }));
    await routeOperation(page, workspaceList, { slug: 'aoba' }, (call) =>
      call.fulfill({
        workspaces: [
          { ...workspace, member_count: 4, leader_count: 2, created_on: '2025-04-01', closed_at: state.closedAt },
        ],
      }),
    );
    return state;
  }

  function workspacePane(page: Page) {
    return page.locator('.pane').filter({ has: page.getByRole('heading', { level: 2, name: 'ワークスペース' }) });
  }

  // ホームから管理の画面へ、アカウントのメニューで移る（ページは読み直さない）
  async function openAdmin(page: Page) {
    await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
    await page.locator('.account-menu-list').getByRole('link', { name: '組織の管理' }).click();
    await expect(page).toHaveURL(/\/aoba\/admin$/);
    return workspacesOf(page).locator('tbody tr', { hasText: workspace.name });
  }

  // 管理の画面から、画面内のリンクでホームへ戻る
  async function backHome(page: Page) {
    await page.locator('#app-nav').getByRole('link', { name: '今日やること', exact: true }).click();
    await expect(page).toHaveURL(/\/aoba$/);
  }

  async function confirmClose(page: Page) {
    await page
      .getByRole('dialog', { name: `「${workspace.name}」を終了しますか？` })
      .getByRole('button', { name: `「${workspace.name}」を終了する` })
      .click();
  }

  test('管理の画面でワークスペースを終了してからホームへ戻ると、ワークスペースの面から外れ、所属が無い案内が出る', async ({
    page,
  }) => {
    const state = await routeState(page, null);
    await routeOperation(page, workspaceClose, { slug: 'aoba' }, (call) => {
      state.closedAt = '2026-11-15T00:00:00.000Z';
      return call.fulfill({ workspace_id: workspace.id, closed_at: state.closedAt });
    });

    await page.goto('/aoba');
    await expect(workspacePane(page).getByRole('link', { name: /受託開発チーム/ })).toBeVisible();

    const row = await openAdmin(page);
    await row.getByRole('button', { name: `「${workspace.name}」を終了する` }).click();
    await confirmClose(page);
    await expect(page.getByRole('status').filter({ hasText: 'ワークスペースを終了しました' })).toBeVisible();
    await backHome(page);

    await expect(workspacePane(page).getByText('どのワークスペースにも所属していません')).toBeVisible();
    await expect(workspacePane(page).getByRole('link', { name: /受託開発チーム/ })).toHaveCount(0);
  });

  test('別の管理者が先に終了していて、終了を断られた（状態が変わっていた）ときも、ホームのワークスペースの面から外れる', async ({
    page,
  }) => {
    const state = await routeState(page, null);
    await routeOperation(page, workspaceClose, { slug: 'aoba' }, (call) => {
      state.closedAt = '2026-11-15T00:00:00.000Z';
      return call.fail(409, 'workspace_closed');
    });

    await page.goto('/aoba');
    await expect(workspacePane(page).getByRole('link', { name: /受託開発チーム/ })).toBeVisible();

    const row = await openAdmin(page);
    await row.getByRole('button', { name: `「${workspace.name}」を終了する` }).click();
    await confirmClose(page);
    await expect(page.getByRole('status').filter({ hasText: '状態が変わっていました' })).toBeVisible();
    await backHome(page);

    await expect(workspacePane(page).getByText('どのワークスペースにも所属していません')).toBeVisible();
    await expect(workspacePane(page).getByRole('link', { name: /受託開発チーム/ })).toHaveCount(0);
  });

  test('終了したワークスペースにだけ所属する管理者が管理の画面で再開してからホームへ戻ると、ワークスペースの面にそのリンクが出て、所属が無い案内が消える', async ({
    page,
  }) => {
    const state = await routeState(page, '2026-10-01T00:00:00.000Z');
    await routeOperation(page, workspaceReopen, { slug: 'aoba' }, (call) => {
      state.closedAt = null;
      return call.fulfill({ workspace_id: workspace.id });
    });

    await page.goto('/aoba');
    await expect(workspacePane(page).getByText('どのワークスペースにも所属していません')).toBeVisible();
    await expect(workspacePane(page).getByRole('link')).toHaveCount(0);

    const row = await openAdmin(page);
    await row.getByRole('button', { name: `「${workspace.name}」を再開する` }).click();
    await expect(page.getByRole('status').filter({ hasText: 'ワークスペースを再開しました' })).toBeVisible();
    await backHome(page);

    await expect(workspacePane(page).getByRole('link', { name: /受託開発チーム/ })).toBeVisible();
    await expect(workspacePane(page).getByText('どのワークスペースにも所属していません')).toHaveCount(0);
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('終了したワークスペースの帯は出るが、再開操作へのリンクは出ない', async ({ page }) => {
    // 受託開発チームを、画面の上だけで終了した状態にする（seed のワークスペースを終了しない）
    await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (body) => {
      body.closed_at = '2026-10-22T00:00:00.000Z';
      return body;
    });
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(bannerOf(page)).toHaveText(BANNER);
    await expect(bannerOf(page).getByRole('link')).toHaveCount(0);
  });
});
