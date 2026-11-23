// ボードの経路（#1497）: サイドバーの「ボード」から /board を開き、前の経路 /sprint は /board へ移す
import { expect, test } from './fixtures.ts';
import { expectBoardHeading, signIn, waitForSettled } from './helpers.ts';
import { mockOperation } from './operations.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const TEAM = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const TASK_ID = '019a0000-0000-7000-8000-000000000801';
const TASK_TITLE = 'ポイント付与のバッチを作る';

test('サイドバーの「ボード」で /board が開き、見出しとタブの題に「ボード」が出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.goto(TEAM);
  await page.getByRole('link', { name: 'ボード', exact: true }).click();
  await expect(page).toHaveURL(`${TEAM}/board`);
  await expectBoardHeading(page, SAMPLE_BOARD.sprint!.name!);
  await expect(page).toHaveTitle(new RegExp(`^ボード・${SAMPLE_BOARD.sprint!.name!}・`));
  await expect(page.getByRole('link', { name: 'ボード', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('前の経路 /sprint?task= を開くと、クエリを保ったまま /board に移り、タスクの引き出しが開く', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const board = structuredClone(SAMPLE_BOARD);
  board.columns[0]!.tasks[0]!.id = TASK_ID;
  board.columns[0]!.tasks[0]!.title = TASK_TITLE;
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, board);
  await page.goto(`${TEAM}/sprint?task=${TASK_ID}`);
  await expect(page).toHaveURL(`${TEAM}/board?task=${TASK_ID}`);
  await waitForSettled(page);
  await expect(page.getByRole('dialog', { name: TASK_TITLE, exact: true })).toBeVisible();
});
