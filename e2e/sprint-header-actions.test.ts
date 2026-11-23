import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { sprintBoard, sprintList } from '../src/shared/operations/sprint/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import { expectFocusReturned, signIn, waitForSettled, expectBoardHeading } from './helpers.ts';
import { mockOperation, rewriteOperation } from './operations.ts';
import { OVERDUE_PLAN, SAMPLE_BOARD } from './sprint-fixture.ts';

const PATH = '/aoba/w/019a0000-0000-7000-8000-000000000401/board';
test.use({ timezoneId: 'Asia/Tokyo' });

for (const today of ['2026-10-20', '2026-10-26', '2026-10-27']) {
  test(`見出しは編集と操作にまとまり、終えるは最終日から表にも出る: ${today}`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, sprintBoard, { slug: 'aoba' }, { ...SAMPLE_BOARD, today });
    await mockOperation(page, sprintList, { slug: 'aoba' }, { ...OVERDUE_PLAN, today });
    await page.goto(PATH);
    const head = page.locator('.page-head');
    const menu = head.getByRole('button', { name: '操作: 第14回', exact: true });
    await expect(head.getByRole('button', { name: 'スプリントを編集: 第14回' })).toHaveText('編集');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('opacity', '1');
    await expect(head.getByRole('button', { name: '延長する', exact: true })).toHaveCount(0);
    await expect(head.getByRole('button', { name: '終える: スプリント「第14回」' })).toHaveCount(
      today < '2026-10-26' ? 0 : 1,
    );
    await menu.click();
    await expect(head.getByRole('menuitem')).toHaveText(['延長する', '終える']);
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    const editTrigger = head.getByRole('button', { name: 'スプリントを編集: 第14回' });
    await editTrigger.click();
    const edit = page.getByRole('dialog', { name: 'スプリントを直す' });
    await expect(edit.getByLabel('名前（任意）')).toHaveValue('第14回');
    await expect(edit.getByLabel('スプリントゴール', { exact: true })).toHaveValue(SAMPLE_BOARD.sprint!.goal!);
    await edit.getByRole('button', { name: 'やめる' }).click();
    await expect(edit).toBeHidden();
    // dialogの非同期closeイベントによる編集ボタンへの復帰を終えてから、次の操作へ進む。
    await expectFocusReturned(page, editTrigger);
    for (const [action, title] of [
      ['延長する', 'スプリントを延ばす'],
      ['終える', 'スプリントを終える'],
    ]) {
      await menu.focus();
      await menu.press('ArrowDown');
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await head.getByRole('menuitem', { name: action, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expectFocusReturned(page, menu);
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
    }
    await waitForSettled(page);
  });
}

for (const state of ['member', 'closed'] as const) {
  test(`${state === 'member' ? 'メンバー' : '閉じたワークスペース'}には見出しの操作を出さない`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, state === 'member' ? 'member' : 'admin');
    if (state === 'closed') {
      // 組織のメニューと、画面がcanLeadを決めるワークスペースの枠の両方へ同じ終了状態を返す。
      // organizationだけを替えると、後から届いたworkspace-infoの開いた状態で操作が再表示される。
      await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
        ...output,
        closed_at: '2026-10-20T00:00:00.000Z',
      }));
      await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
        ...output,
        workspaces: output.workspaces.map((workspace) => ({ ...workspace, closed_at: '2026-10-20T00:00:00.000Z' })),
      }));
    }
    await mockOperation(page, sprintBoard, { slug: 'aoba' }, { ...SAMPLE_BOARD, today: '2026-10-26' });
    await page.goto(PATH);
    await expectBoardHeading(page, '第14回');
    await waitForSettled(page);
    if (state === 'closed') {
      await expect(
        page.locator('.callout.is-info', { hasText: '2026-10-20 に終了しました。読み取り専用です。' }),
      ).toBeVisible();
    }
    await expect(page.locator('.page-actions').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '終える', exact: true })).toHaveCount(0);
  });
}

for (const today of ['2026-10-20', '2026-10-26']) {
  test(`390pxでも見出しの操作は画面内に収まり押せる: ${today}`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, sprintBoard, { slug: 'aoba' }, { ...SAMPLE_BOARD, today });
    await page.goto(PATH);
    const actions = page.locator('.page-actions');
    await expect(actions.getByRole('button', { name: '操作: 第14回', exact: true })).toBeVisible();
    for (const button of await actions.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await actions.getByRole('button', { name: '操作: 第14回', exact: true }).click();
    await expect(actions.getByRole('menuitem', { name: '延長する', exact: true })).toBeVisible();
  });
}
