// ボードの検索、担当のアバター、フィルター（#1502）。sprint-board の応答を架空のボードに差し替え（seed の行も DB も書き換えない）、
// 絞り込みが URL に残ること、読み直しても保たれること、絞って空になった列の文言、4つの見た目（2つのテーマ × 広い幅と 390px）の
// axe と、390px のはみ出しと 44px を確かめる。?story= のリンクと親名の押しでの絞り込みは e2e/sprint-story-filter.test.ts
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  A11Y_THEMES,
  NARROW_VIEWPORT,
  applyTheme,
  createLayoutCheck,
  findA11yViolations,
  signIn,
  waitForSettled,
} from './helpers.ts';
import { mockOperation, routeOperation } from './operations.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { taskCreate } from '../src/shared/operations/task/index.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

type Board = OutputOf<typeof sprintBoard>;

const PATH = '/aoba/w/019a0000-0000-7000-8000-000000000401/board';
const HARUKA = { id: '019a0000-0000-7000-8000-000000000302', name: 'ハルカ' };
const MINATO = { id: '019a0000-0000-7000-8000-000000000301', name: 'ミナト' };
const STORY = { id: '019a0000-0000-7000-8000-00000000f301', title: 'ポイントの付与と失効を管理画面で確かめられる' };
const EPIC = { id: '019a0000-0000-7000-8000-00000000f501', title: '会員ポイント制度を公開する' };
const MAINTENANCE = { id: '019a0000-0000-7000-8000-00000000f601', name: '保守' };

// SAMPLE_BOARD（未着手2、作業中1、レビュー0、完了1）に、エピックと区分を添える。
// 未着手: 「管理画面に…」（ハルカ、ストーリーとエピック）、「障害時の…」（担当なし、区分「保守」）
// 作業中: 「ポイント付与の…」（ミナト）。完了: 「付与の履歴を…」（ミナト、ストーリーとエピック）
function board(): Board {
  const next = structuredClone(SAMPLE_BOARD);
  const [todo, working, , done] = next.columns;
  todo!.tasks[0]!.epic = EPIC;
  todo!.tasks[1]!.category = MAINTENANCE;
  done!.tasks[0]!.story = STORY;
  done!.tasks[0]!.epic = EPIC;
  void working;
  return next;
}

const cards = (page: Page) => page.locator('.card');
const toolbar = (page: Page) => page.getByRole('search', { name: 'ボードの絞り込み', exact: true });
const avatar = (page: Page, name: string) =>
  toolbar(page).getByRole('group', { name: '担当で絞り込む', exact: true }).getByRole('button', { name, exact: true });
const filterButton = (page: Page) => toolbar(page).getByRole('button', { name: /^フィルター/ });

async function openFilters(page: Page) {
  const button = filterButton(page);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const dialog = page.getByRole('dialog', { name: 'ボードのフィルター', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function cardTitles(page: Page): Promise<string[]> {
  return page.locator('.card .card-title').allInnerTexts();
}

test.beforeEach(async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, board());
});

test('検索の語を打つと題にその語を含むカードだけが残り、URL に残って読み直しても保たれる', async ({ page }) => {
  await page.goto(PATH);
  await expect(cards(page)).toHaveCount(4);
  const search = toolbar(page).getByRole('searchbox', { name: 'ボードを検索', exact: true });
  await search.fill('ポイント');
  await expect(cards(page)).toHaveCount(2);
  expect(await cardTitles(page)).toEqual(['管理画面にポイント履歴の一覧を出す', 'ポイント付与のバッチを作る']);
  await expect(page).toHaveURL(/[?&]q=%E3%83%9D%E3%82%A4%E3%83%B3%E3%83%88/);
  // 列の件数とポイントは絞った後の値で、帯の下に条件と表示している件数を出す
  await expect(page.locator('.board-col').first().locator('.board-col-n')).toHaveText('1');
  await expect(page.locator('.board-filter-summary')).toContainText('「ポイント」');
  await expect(page.locator('.board-filter-summary')).toContainText('4 件中 2 件を表示');
  await page.reload();
  await expect(cards(page)).toHaveCount(2);
  await expect(search).toHaveValue('ポイント');
  // 大文字と小文字、全角と半角を区別しない
  await search.fill('ａｐｉ');
  await search.press('Enter');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('付与の履歴を返す API を作る');
});

test('担当のアバターを押すとその人のカードだけになり、もう1人押すと2人分、担当なしで担当のないカードが出る', async ({
  page,
}) => {
  await page.goto(PATH);
  await expect(cards(page)).toHaveCount(4);
  await avatar(page, 'ハルカ').click();
  await expect(avatar(page, 'ハルカ')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(page)).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`assignee=${HARUKA.id}`));
  await avatar(page, 'ミナト').click();
  await expect(cards(page)).toHaveCount(3);
  await avatar(page, 'ハルカ').click();
  await expect(avatar(page, 'ハルカ')).toHaveAttribute('aria-pressed', 'false');
  await expect(cards(page)).toHaveCount(2);
  await avatar(page, 'ミナト').click();
  await avatar(page, '担当なし').click();
  expect(await cardTitles(page)).toEqual(['障害時の連絡手順を書く']);
  // アバターとフィルターの担当は同じ条件
  const dialog = await openFilters(page);
  await expect(
    dialog.getByRole('group', { name: '担当', exact: true }).getByRole('checkbox', { name: /担当なし/ }),
  ).toBeChecked();
  await expect(filterButton(page)).toHaveText(/フィルター（1）/);
});

test('フィルターからストーリー、エピック、担当、区分を選んで絞り、すべてクリアで全件に戻る', async ({ page }) => {
  await page.goto(PATH);
  const dialog = await openFilters(page);
  const group = (name: string) => dialog.getByRole('group', { name, exact: true });
  await group('エピック')
    .getByRole('checkbox', { name: new RegExp(EPIC.title) })
    .check();
  await expect(cards(page)).toHaveCount(2);
  await group('担当')
    .getByRole('checkbox', { name: /ミナト/ })
    .check();
  expect(await cardTitles(page)).toEqual(['付与の履歴を返す API を作る']);
  await group('担当')
    .getByRole('checkbox', { name: /ミナト/ })
    .uncheck();
  await group('ストーリー')
    .getByRole('checkbox', { name: new RegExp(STORY.title) })
    .check();
  await expect(cards(page)).toHaveCount(2);
  await group('エピック')
    .getByRole('checkbox', { name: new RegExp(EPIC.title) })
    .uncheck();
  await group('ストーリー')
    .getByRole('checkbox', { name: new RegExp(STORY.title) })
    .uncheck();
  await group('区分').getByRole('checkbox', { name: /保守/ }).check();
  expect(await cardTitles(page)).toEqual(['障害時の連絡手順を書く']);
  await group('区分')
    .getByRole('checkbox', { name: /区分なし/ })
    .check();
  await expect(cards(page)).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(filterButton(page)).toBeFocused();
  await expect(filterButton(page)).toHaveText(/フィルター（2）/);

  await toolbar(page).getByRole('button', { name: 'すべてクリア', exact: true }).click();
  await expect(cards(page)).toHaveCount(4);
  await expect(page).not.toHaveURL(/category=/);
  await expect(page.locator('.board-filter-summary')).toHaveCount(0);
  await expect(toolbar(page).getByRole('searchbox', { name: 'ボードを検索', exact: true })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: '絞り込みをすべて外しました' })).toBeVisible();
});

test('組み合わせた絞り込みは読み直しても保たれ、絞って空になった列には隠していることを出す', async ({ page }) => {
  await page.goto(`${PATH}?q=%E7%AE%A1%E7%90%86&assignee=${HARUKA.id}&epic=${EPIC.id}`);
  await expect(cards(page)).toHaveCount(1);
  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(avatar(page, 'ハルカ')).toHaveAttribute('aria-pressed', 'true');
  await expect(avatar(page, 'ミナト')).toHaveAttribute('aria-pressed', 'false');
  await expect(filterButton(page)).toHaveText(/フィルター（2）/);
  await expect(toolbar(page).getByRole('searchbox')).toHaveValue('管理');
  // 作業中の列にはカードが1枚あるが隠れている。レビューの列は元から空
  await expect(page.locator('.board-col').nth(1).locator('.board-empty')).toHaveText('絞り込みで 1 件を隠しています');
  await expect(page.locator('.board-col').nth(2).locator('.board-empty')).toHaveText('なし');
  // 今のボードに無い値は外して知らせ、残りの条件は保つ
  await page.goto(`${PATH}?assignee=${HARUKA.id}&assignee=019a0000-0000-7000-8000-0000000003ff`);
  await expect(page).not.toHaveURL(/0000000003ff/);
  await expect(page).toHaveURL(new RegExp(`assignee=${HARUKA.id}`));
  await expect(
    page.getByRole('status').filter({ hasText: '絞り込み対象の一部が現在のボードにないため、外しました' }),
  ).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  // ?task= で引き出しを開いても、カードのリンクは絞り込みを保つ
  await expect(page.locator('a.card-title').first()).toHaveAttribute('href', new RegExp(`assignee=${HARUKA.id}`));
});

test('絞っている間に追加の行で作ったタスクが絞り込みに当たらないときは、隠れていることを知らせる', async ({ page }) => {
  const current = board();
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, (call) => call.fulfill(current));
  await routeOperation(page, taskCreate, { slug: 'aoba' }, async (call) => {
    const task = {
      ...current.columns[0]!.tasks[1]!,
      id: '019a0000-0000-7000-8000-00000000f299',
      title: call.input.title,
      category: null,
    };
    current.columns[0]!.tasks.push(task);
    await call.fulfill({
      task: {
        id: task.id,
        title: task.title,
        points: null,
        due_on: null,
        assignee: null,
        delegatee: null,
        category: null,
        repository: null,
        sprint: null,
        can_delete: false,
      },
    });
  });
  await page.goto(`${PATH}?q=%E7%AE%A1%E7%90%86`);
  await expect(cards(page)).toHaveCount(1);
  const input = page.getByRole('textbox', { name: 'タスクを足す: 未着手', exact: true });
  await input.fill('請求の確認');
  await input.press('Enter');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '「請求の確認」を未着手に足しました。絞り込みに当たらないため隠れています' }),
  ).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  // 当たる題なら見えて、ふだんの知らせになる
  await input.fill('管理の手順を書く');
  await input.press('Enter');
  // 「隠れています」の知らせと接頭辞が同じなので、文の全体が一致することで、ふだんの知らせであることを確かめる
  await expect(page.getByText('「管理の手順を書く」を未着手に足しました', { exact: true })).toBeVisible();
  await expect(page.getByText(/「管理の手順を書く」.*隠れています/)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);
});

for (const theme of A11Y_THEMES) {
  for (const width of [1280, NARROW_VIEWPORT.width]) {
    test(`絞り込みの帯とフィルターの小窓の axe: ${theme}・${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${PATH}?assignee=${MINATO.id}&story=${STORY.id}`);
      await expect(cards(page)).toHaveCount(1);
      await applyTheme(page, theme);
      expect(await findA11yViolations(page, '.board-page')).toEqual([]);
      await openFilters(page);
      await waitForSettled(page);
      expect(await findA11yViolations(page, '.board-page')).toEqual([]);
    });
  }
}

test('390px で絞り込みの帯とフィルターの小窓が横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(`${PATH}?assignee=${MINATO.id}&q=%E4%BB%98%E4%B8%8E`);
  await expect(cards(page)).toHaveCount(2);
  await openFilters(page);
  await page.waitForLoadState('networkidle');
  const check = createLayoutCheck('sprint');
  await check.inThemes(page);
  check.finish();
  for (const name of ['ハルカ', 'ミナト', '担当なし']) {
    const box = (await avatar(page, name).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
