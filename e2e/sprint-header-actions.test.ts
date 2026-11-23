// ボードの道具の帯の右端のスプリントのボタンと小窓（#1498）。小窓の開閉とフォーカス、中身（期間、進み具合、ゴール）、
// リーダーとメンバーの操作の出し分け、期限切れの印、狭い幅での収まりを確かめる
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { sprintBoard, sprintList } from '../src/shared/operations/sprint/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import {
  A11Y_THEMES,
  applyTheme,
  expectBoardHeading,
  expectFocusReturned,
  findA11yViolations,
  findTargetSizeViolations,
  openSprintPopover,
  signIn,
  sprintButton,
  waitForSettled,
} from './helpers.ts';
import { mockOperation, rewriteOperation } from './operations.ts';
import { OVERDUE_BOARD, OVERDUE_PLAN, SAMPLE_BOARD } from './sprint-fixture.ts';

const PATH = '/aoba/w/019a0000-0000-7000-8000-000000000401/board';
test.use({ timezoneId: 'Asia/Tokyo' });

for (const [today, day, remaining] of [
  ['2026-10-20', 8, 7],
  ['2026-10-26', 14, 1],
  ['2026-10-27', 14, 0],
] as const) {
  test(`スプリントのボタンの小窓に期間とゴールを出し、リーダーは編集・延長・終了を開ける: ${today}`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, sprintBoard, { slug: 'aoba' }, { ...SAMPLE_BOARD, today });
    await mockOperation(page, sprintList, { slug: 'aoba' }, { ...OVERDUE_PLAN, today });
    await page.goto(PATH);
    await expectBoardHeading(page, '第14回');
    const button = sprintButton(page);
    const overdue = today > SAMPLE_BOARD.sprint!.end_on;
    await expect(button).toHaveAccessibleName(
      overdue ? 'スプリントの情報: 第14回 期限切れ（最終日を過ぎています）' : 'スプリントの情報: 第14回',
    );
    if (overdue) await expect(button).toHaveClass(/is-warn/);
    else await expect(button).not.toHaveClass(/is-warn/);
    // 期限切れは色とアイコンだけでなく、見える言葉でも示す
    await expect(button.locator('.popover-btn-note')).toHaveText(overdue ? ['期限切れ'] : []);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    // 見出しの下には、前の大きな見出しの中身（進み具合の棒、ゴールの貼り紙、期限切れの知らせ）を置かない
    await expect(page.locator('.page-head .page-eyebrow')).toHaveCount(0);
    await expect(page.locator('.progress-bar')).toHaveCount(0);
    await expect(page.locator('.notice')).toHaveCount(0);
    await expect(page.locator('.callout.is-warn')).toHaveCount(0);
    // 見出しと列の間は、1段の帯だけ（前の見出しの進み具合の棒とゴールの貼り紙の分、列の先頭が上に来る）
    const headBottom = (await page.locator('.page-head').boundingBox())!;
    const toolbar = (await page.locator('.board-toolbar').boundingBox())!;
    const column = (await page.locator('.board-col').first().boundingBox())!;
    expect(toolbar.y).toBeGreaterThan(headBottom.y + headBottom.height);
    expect(column.y - (toolbar.y + toolbar.height)).toBeLessThanOrEqual(16);
    expect(column.y - (headBottom.y + headBottom.height)).toBeLessThan(120);

    const popover = await openSprintPopover(page);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(popover).toBeFocused();
    await expect(popover.getByRole('heading', { level: 2 })).toHaveText('第14回');
    await expect(popover.locator('.popover-meta')).toHaveText(`10/13〜10/26・14 日のうち ${day} 日目`);
    await expect(popover.locator('.progress-num')).toHaveText('完了 2 / 10 pt（20%）');
    await expect(popover.locator('.progress-remaining')).toHaveText(`残り ${remaining} 日`);
    await expect(popover.locator('.popover-label')).toHaveText('スプリントゴール');
    await expect(popover.locator('.popover-text')).toHaveText(SAMPLE_BOARD.sprint!.goal!);
    await expect(popover.locator('.callout.is-warn')).toHaveCount(overdue ? 1 : 0);
    await expect(popover.locator('.popover-actions').getByRole('button')).toHaveText(['編集', '延長する', '終える']);

    // Esc で閉じてボタンへ戻る
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    // 小窓の外（地）を押すと閉じ、フォーカスはボタンへ戻る
    await openSprintPopover(page);
    await page.locator('.board-toolbar').click({ position: { x: 4, y: 4 } });
    await expect(popover).toBeHidden();
    await expect(button).toBeFocused();

    // 小窓の外の欄を押すと閉じ、押した欄に残る。地を押して閉じた後に欄を押しても、離した時にボタンへ奪い返さない
    const draft = page.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true });
    await openSprintPopover(page);
    await draft.click();
    await expect(popover).toBeHidden();
    await expect(draft).toBeFocused();
    await openSprintPopover(page);
    await page.locator('.board-toolbar').click({ position: { x: 4, y: 4 } });
    await expect(button).toBeFocused();
    await draft.click();
    await expect(draft).toBeFocused();

    // Tab で小窓の外へ出ると閉じ、出た先に残る
    await openSprintPopover(page);
    // 期限切れのときは、知らせの「終える」が操作の前に入る
    for (let i = 0; i < (overdue ? 4 : 3); i++) await page.keyboard.press('Tab');
    await expect(
      popover.getByRole('button', { name: '終える: スプリント「第14回」', exact: true }).last(),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(popover).toBeHidden();
    await expect(button).not.toBeFocused();

    // 小窓の操作は小窓を閉じてダイアログを開き、ダイアログを閉じるとスプリントのボタンへ戻る
    for (const [action, title] of [
      ['スプリントを編集: 第14回', 'スプリントを直す'],
      ['延長する', 'スプリントを延ばす'],
      ['終える: スプリント「第14回」', 'スプリントを終える'],
    ]) {
      await (
        await openSprintPopover(page)
      )
        .locator('.popover-actions')
        .getByRole('button', { name: action, exact: true })
        .click();
      await expect(popover).toBeHidden();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      if (title === 'スプリントを直す') {
        await expect(dialog.getByLabel('名前（任意）')).toHaveValue('第14回');
        await expect(dialog.getByLabel('スプリントゴール', { exact: true })).toHaveValue(SAMPLE_BOARD.sprint!.goal!);
      }
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expectFocusReturned(page, button);
    }
    await waitForSettled(page);
  });
}

for (const state of ['member', 'closed'] as const) {
  test(`${state === 'member' ? 'メンバー' : '閉じたワークスペース'}には小窓の操作を出さず、中身は読める`, async ({
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
    const popover = await openSprintPopover(page);
    await expect(popover.locator('.popover-meta')).toHaveText('10/13〜10/26・14 日のうち 14 日目');
    await expect(popover.locator('.popover-text')).toHaveText(SAMPLE_BOARD.sprint!.goal!);
    await expect(popover.getByRole('button')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sprintButton(page)).toBeFocused();
  });
}

for (const today of ['2026-10-20', '2026-10-27']) {
  test(`390pxでもスプリントのボタンと小窓は画面内に収まり押せる: ${today}`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, sprintBoard, { slug: 'aoba' }, { ...SAMPLE_BOARD, today });
    await page.goto(PATH);
    const button = sprintButton(page);
    const inside = async (box: { x: number; width: number } | null): Promise<void> => {
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    };
    const buttonBox = await button.boundingBox();
    await inside(buttonBox);
    expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
    const popover = await openSprintPopover(page);
    await inside(await popover.boundingBox());
    for (const action of await popover.getByRole('button').all()) {
      const box = await action.boundingBox();
      await inside(box);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
}

// 4つの見た目（シンプルのライトとダーク、PC とスマホの幅）で、小窓を開いた画面に axe の違反がなく、スマホの幅では 44px に満たない押せる範囲がない
for (const width of [1280, 390]) {
  for (const theme of A11Y_THEMES) {
    test(`小窓を開いたボードの axe と押せる範囲: ${theme} ${width}px`, async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(context, baseURL, 'admin');
      await mockOperation(page, sprintBoard, { slug: 'aoba' }, OVERDUE_BOARD);
      await mockOperation(page, sprintList, { slug: 'aoba' }, OVERDUE_PLAN);
      await page.goto(PATH);
      await expectBoardHeading(page, '第14回');
      await waitForSettled(page);
      await applyTheme(page, theme);
      await openSprintPopover(page);
      expect(await findA11yViolations(page)).toEqual([]);
      // 押せる範囲 44px は、760px 以下と指で押す画面の決まり（広い幅のマウスの画面は詰める）
      if (width <= 760) expect(await findTargetSizeViolations(page)).toEqual([]);
    });
  }
}
