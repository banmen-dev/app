import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, NARROW_VIEWPORT, applyTheme, dragTo, findA11yViolations, signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';
import { sprintBoard, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { taskAssign, taskComplete } from '../src/shared/operations/task/index.ts';

const PATH = '/aoba/w/019a0000-0000-7000-8000-000000000401/board';
const HARUKA = SAMPLE_BOARD.columns[0]!.tasks[0]!.assignee!;
const MINATO = SAMPLE_BOARD.columns[1]!.tasks[0]!.assignee!;
const TITLE = SAMPLE_BOARD.columns[0]!.tasks[0]!.title;
const WORKING = SAMPLE_BOARD.columns[1]!.id;
const EPIC = { id: '019a0000-0000-7000-8000-00000000f501', title: '会員ポイント制度を公開する' };

const groupSelect = (page: Page) => page.getByRole('combobox', { name: 'グループ', exact: true });
const lane = (page: Page, name: string) => page.getByRole('group', { name, exact: true });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function setupBoard(page: Page) {
  const board = structuredClone(SAMPLE_BOARD);
  board.columns[0]!.tasks[0]!.epic = EPIC;
  let reads = 0;
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => {
    reads += 1;
    return call.fulfill(board);
  });
  return { board, readCount: () => reads };
}

test('グループを選び、折りたたみと起票の書きかけを保ち、検索・絞り込みと併用できる', async ({ page }) => {
  await setupBoard(page);
  await page.goto(PATH);
  const select = groupSelect(page);
  const draft = page.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true });
  await draft.fill('書きかけの題');
  await expect(select).toHaveValue('');
  for (const [label, missing] of [
    ['ストーリー', '親なし'],
    ['エピック', 'エピックなし'],
    ['担当者', '担当なし'],
  ]) {
    await select.selectOption({ label });
    await expect(lane(page, missing)).toBeVisible();
    await expect(page.locator('.board-lane').last()).toHaveAttribute('aria-label', missing);
  }
  await expect(draft).toHaveValue('書きかけの題');
  const haruka = lane(page, HARUKA.name);
  const toggle = haruka.getByRole('button', { name: 'ハルカ 1 件' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(haruka.getByRole('link', { name: TITLE, exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(haruka.getByRole('link', { name: TITLE, exact: true })).toBeVisible();

  const search = page.getByRole('searchbox', { name: 'ボードを検索' });
  await search.fill('ポイント');
  await search.press('Enter');
  await page.getByRole('search').getByRole('button', { name: HARUKA.name, exact: true }).click();
  await expect(page.locator('.board-lane')).toHaveCount(1);
  await page.reload();
  await expect(select).toHaveValue('assignee');
  await expect(search).toHaveValue('ポイント');
  await expect(page.locator('.board-lane')).toHaveCount(1);
  await expect(haruka.getByRole('link', { name: TITLE, exact: true })).toHaveAttribute('href', /group=assignee/);
  await page.getByRole('button', { name: 'すべてクリア' }).click();
  await expect(page.locator('.board-lane')).toHaveCount(3);
  await expect(select).toHaveValue('assignee');
  await select.selectOption({ label: 'なし' });
  await expect(page.locator('.board-lane')).toHaveCount(0);
});

const moveCases = [
  { index: 1, failure: null },
  { index: 1, failure: 'assign' },
  { index: 1, failure: 'move' },
  { index: 0, failure: null },
  { index: 3, failure: null },
  { index: 3, failure: 'complete' },
] as const;

for (const { index, failure } of moveCases) {
  test(`担当の帯をまたぐと担当を先に保存する（列 ${index}、失敗 ${failure ?? 'なし'}）`, async ({ page }) => {
    const { board, readCount } = await setupBoard(page);
    const source = board.columns[0]!;
    const destination = board.columns[index]!;
    const task = source.tasks[0]!;
    const writes: string[] = [];
    await routeOperation(page, taskAssign, { slug: 'aoba' }, async ({ input, fail, fulfill }) => {
      expect.soft(input).toMatchObject({ task_id: task.id, assignee_user_id: MINATO.id });
      writes.push('assign');
      if (failure === 'assign') return fail(404, 'not_found');
      task.assignee = MINATO;
      await fulfill({
        task: {
          id: task.id,
          title: task.title,
          body_md: null,
          points: 5,
          due_on: null,
          link_url: null,
          assignee: { ...MINATO, left: false },
          delegatee: null,
          is_imported: false,
          completed_at: null,
          reopenable: false,
          can_delete: false,
          story_id: task.story?.id ?? null,
          category: null,
          repository: null,
          sprint: null,
        },
      });
    });
    await routeOperation(page, taskColumnMove, { slug: 'aoba' }, async ({ input, fail, fulfill }) => {
      expect.soft(writes).toEqual(['assign']);
      expect.soft(input).toMatchObject({ task_id: task.id, column_id: destination.id });
      writes.push('move');
      if (failure === 'move') return fail(404, 'not_found');
      source.tasks.splice(0, 1);
      destination.tasks.push(task);
      await fulfill({ task_id: task.id, column_id: destination.id });
    });
    await routeOperation(page, taskComplete, { slug: 'aoba' }, async ({ input, fail, fulfill }) => {
      expect.soft(writes).toEqual(['assign']);
      expect.soft(input.task_id).toBe(task.id);
      writes.push('complete');
      if (failure === 'complete') return fail(500, 'internal');
      task.completed_at = '2026-10-20T00:00:00.000Z';
      source.tasks.splice(0, 1);
      destination.tasks.push(task);
      await fulfill({ task_id: task.id, completed_at: task.completed_at, left_sprint: false });
    });
    await page.goto(`${PATH}?group=assignee`);
    await expect(lane(page, HARUKA.name)).toBeVisible();
    const readsBefore = readCount();
    await dragTo(
      page,
      lane(page, HARUKA.name).getByRole('link', { name: TITLE, exact: true }),
      lane(page, MINATO.name).locator(`[data-column="${destination.id}"]`),
      'middle',
    );
    await expect.poll(readCount).toBeGreaterThan(readsBefore);
    if (failure === 'move' || failure === 'complete') {
      await expect(page.getByRole('status').filter({ hasText: '担当を「ミナト」に変更しました' })).toBeVisible();
    }
    const current = lane(page, failure === 'assign' ? HARUKA.name : MINATO.name);
    await expect(
      current
        .locator(`[data-column="${failure === null ? destination.id : source.id}"]`)
        .getByRole('link', { name: TITLE, exact: true }),
    ).toBeVisible();
    expect(writes).toEqual(
      failure === 'assign' || index === 0 ? ['assign'] : ['assign', index === 3 ? 'complete' : 'move'],
    );
  });
}

test('Alt と上下キーで、同じ列の同じ帯のカードだけを並べ替える', async ({ page }) => {
  const { board } = await setupBoard(page);
  const column = board.columns[0]!;
  const card = column.tasks[0]!;
  const second = { ...card, id: '019a0000-0000-7000-8000-00000000f299', title: '同じ担当の別のカード' };
  column.tasks.push(second);
  const writes: (string | null | undefined)[] = [];
  await routeOperation(page, taskColumnMove, { slug: 'aoba' }, async ({ input, fulfill }) => {
    expect.soft(input.task_id).toBe(second.id);
    writes.push(input.after_task_id);
    await fulfill({ task_id: second.id, column_id: column.id });
  });
  await page.goto(`${PATH}?group=assignee`);
  const cards = lane(page, HARUKA.name).locator(`[data-column="${column.id}"] .card`);
  await expect(cards.locator('.card-title')).toHaveText([card.title, second.title]);
  await cards.last().press('Alt+ArrowUp');
  await expect(cards.locator('.card-title')).toHaveText([second.title, card.title]);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([null]);
});

test('カードがない帯は、絞り込んだ状態と起票できる空の状態を区別する', async ({ page }) => {
  const { board } = await setupBoard(page);
  for (const column of board.columns) column.tasks = [];
  await page.goto(`${PATH}?group=story`);
  await expect(page.getByText('カードはありません。列の末尾の行からタスクを足せます。')).toBeVisible();
  await page.getByRole('searchbox', { name: 'ボードを検索' }).fill('管理');
  await expect(page.getByText('当たるものはありません', { exact: true })).toBeVisible();
});

test('狭い幅でも長い帯名と件数がスクロール枠に収まる', async ({ page }) => {
  const { board } = await setupBoard(page);
  const title = '受付から一次回答までの確認をして案内文を整える'.repeat(5);
  board.columns[0]!.tasks[0]!.story!.title = title;
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(`${PATH}?group=story`);
  const band = lane(page, title);
  const count = band.locator('.board-lane-toggle .board-col-n');
  await expect(count).toHaveText('1 件');
  const box = (await count.boundingBox())!;
  const wrap = (await page.locator('.board-wrap').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(wrap.x + wrap.width);
});

for (const [group, title, missing] of [
  ['story', SAMPLE_BOARD.columns[0]!.tasks[0]!.story!.title, '親なし'],
  ['epic', EPIC.title, 'エピックなし'],
]) {
  test(`${group} の帯をまたぐドロップは拒否する`, async ({ page }) => {
    await setupBoard(page);
    const writes: string[] = [];
    await routeOperation(page, taskAssign, { slug: 'aoba' }, (call) => {
      writes.push('assign');
      return call.fail(500, 'internal');
    });
    await routeOperation(page, taskColumnMove, { slug: 'aoba' }, (call) => {
      writes.push('move');
      return call.fail(500, 'internal');
    });
    await page.goto(`${PATH}?group=${group}`);
    const card = lane(page, title!).getByRole('link', { name: TITLE, exact: true });
    const dest = lane(page, missing!).locator(`[data-column="${WORKING}"]`);
    await dragTo(page, card, dest, 'middle', () => expect(dest).toHaveAttribute('data-drop', 'blocked'));
    await expect(dest).not.toHaveAttribute('data-drop', 'blocked');
    await expect(card).toBeVisible();
    expect(writes).toEqual([]);
  });
}

for (const theme of A11Y_THEMES) {
  for (const width of [1280, NARROW_VIEWPORT.width]) {
    test(`グループと帯の axe と 44px の押せる範囲: ${theme}・${width}px`, async ({ page }) => {
      await setupBoard(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${PATH}?group=assignee`);
      await expect(page.locator('.board-lane')).toHaveCount(3);
      await applyTheme(page, theme);
      expect(await findA11yViolations(page, '.board-page')).toEqual([]);
      for (const control of [groupSelect(page), ...(await page.locator('.board-lane-toggle').all())]) {
        await control.evaluate((node) => {
          node.scrollIntoView({ block: 'center', inline: 'start' });
          const board = node.closest('.board-wrap');
          if (board !== null) board.scrollLeft = 0;
        });
        const misses = await control.evaluate((control) => {
          const box = control.getBoundingClientRect();
          const clip = control.closest('.board-wrap')?.getBoundingClientRect();
          const left = Math.max(box.left, clip?.left ?? 0, 0);
          const right = Math.min(box.right, clip?.right ?? window.innerWidth, window.innerWidth);
          const x = (left + right) / 2;
          const y = (box.top + box.bottom) / 2;
          if (right - left < 44 || box.height < 44) return ['44px 未満'];
          return [
            [0, 0],
            [-21, 0],
            [21, 0],
            [0, -21],
            [0, 21],
          ].filter(([dx, dy]) => {
            const hit = document.elementFromPoint(x + dx!, y + dy!);
            return hit === null || !control.contains(hit);
          });
        });
        expect(misses).toEqual([]);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
}
