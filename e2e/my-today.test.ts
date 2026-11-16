// 全組織の今日やること。実際の API で2組織の本人タスクを作り、/ から詳細へ移れることを確かめる。
import { myToday } from '../src/shared/operations/organization/my-today.ts';
import { organizationInfo } from '../src/shared/operations/organization/organization.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { taskCreate, taskDelete, taskTodayMark } from '../src/shared/operations/task/index.ts';
import { workspaceCreate, workspaceClose } from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import { findA11yViolations, signIn } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

const pane = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: '全組織の今日やること', exact: true });
const empty: OutputOf<typeof myToday> = { tasks: [], omitted_organizations: 0, failed_organizations: [] };

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('2組織の本人タスクを組織名とともに表示し、各組織の詳細へ移れる', async ({ page, browser, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const headers = { Origin: new URL(baseURL).origin };
  const otherAdmin = await browser.newContext({ baseURL });
  await signIn(otherAdmin, baseURL, 'otherOrg');
  const workspaces: { slug: string; id: string }[] = [];
  const made: {
    slug: string;
    workspaceId: string;
    taskId: string;
    title: string;
    organizationName: string;
    workspaceName: string;
  }[] = [];
  try {
    for (const slug of ['aoba', 'hibari']) {
      const infoResponse = await page.request.post(`/api/${slug}/${organizationInfo.name}`, { headers, data: {} });
      expect(infoResponse.status()).toBe(200);
      const info = organizationInfo.output.parse(await infoResponse.json());
      // 既存のバックログの件数を変えないよう、各組織にこのテストだけのワークスペースを作る。
      const creator = slug === 'aoba' ? page.request : otherAdmin.request;
      const workspaceName = `${slug} の全組織の今日 ${crypto.randomUUID().slice(0, 8)}`;
      const workspaceResponse = await creator.post(`/api/${slug}/${workspaceCreate.name}`, {
        headers,
        data: { name: workspaceName, timezone: 'Asia/Tokyo', leader_user_id: info.me.id },
      });
      expect(workspaceResponse.status()).toBe(200);
      const { workspace_id: workspaceId } = workspaceCreate.output.parse(await workspaceResponse.json());
      workspaces.push({ slug, id: workspaceId });
      const title = `${slug} の今日の確認 ${crypto.randomUUID()}`;
      const created = await page.request.post(`/api/${slug}/${taskCreate.name}`, {
        headers,
        data: { workspace_id: workspaceId, title, assignee_user_id: info.me.id },
      });
      expect(created.status()).toBe(200);
      const { task } = taskCreate.output.parse(await created.json());
      made.push({
        slug,
        workspaceId,
        taskId: task.id,
        title,
        organizationName: info.organization.name,
        workspaceName,
      });
      const marked = await page.request.post(`/api/${slug}/${taskTodayMark.name}`, {
        headers,
        data: { workspace_id: workspaceId, task_id: task.id, marked: true },
      });
      expect(marked.status()).toBe(200);
    }
    for (const task of made) {
      await page.goto('/');
      const row = pane(page)
        .locator('.entry')
        .filter({ has: page.getByRole('link', { name: task.title, exact: true }) });
      await expect(row).toContainText(task.organizationName);
      await expect(row).toContainText(task.workspaceName);
      await expect(row.getByRole('button')).toHaveCount(0);
      const link = row.getByRole('link', { name: task.title, exact: true });
      await expect(link).toHaveAttribute('href', `/${task.slug}/w/${task.workspaceId}?task=${task.taskId}`);
      await link.click();
      await expect(page).toHaveURL(new URL(`/${task.slug}/w/${task.workspaceId}?task=${task.taskId}`, baseURL).href);
      await expect(page.getByRole('dialog', { name: task.title, exact: true })).toBeVisible();
    }
  } finally {
    for (const task of made) {
      const deleted = await page.request.post(`/api/${task.slug}/${taskDelete.name}`, {
        headers,
        data: { workspace_id: task.workspaceId, task_id: task.taskId },
      });
      expect(deleted.status()).toBe(200);
    }
    for (const workspace of workspaces) {
      const closer = workspace.slug === 'aoba' ? page.request : otherAdmin.request;
      const closed = await closer.post(`/api/${workspace.slug}/${workspaceClose.name}`, {
        headers,
        data: { workspace_id: workspace.id },
      });
      expect(closed.status()).toBe(200);
    }
    await otherAdmin.close();
  }
});

test('空なら案内を出し、狭い幅でもニュースの上に置く', async ({ page }) => {
  await mockOperation(page, myToday, empty);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(pane(page)).toContainText('今日やることはまだありません。各組織のバックログから探せます。');
  await expect(pane(page).locator('.entry')).toHaveCount(0);
  const todayBox = await pane(page).boundingBox();
  const newsBox = await page.getByRole('region', { name: 'Scrum Guild のニュース', exact: true }).boundingBox();
  expect(todayBox).not.toBeNull();
  expect(newsBox).not.toBeNull();
  expect(todayBox!.y + todayBox!.height).toBeLessThanOrEqual(newsBox!.y);
  expect(await findA11yViolations(page)).toEqual([]);
});

test('上限と読み取れなかった組織を伝え、失敗を空の一覧にしない', async ({ page }) => {
  await mockOperation(page, myToday, {
    ...empty,
    omitted_organizations: 2,
    failed_organizations: [{ slug: 'hibari', name: 'ひばり工房', kind: 'team' }],
  });
  await page.goto('/');
  await expect(pane(page)).toContainText('ほか 2 組織は読み込んでいません');
  await expect(pane(page).getByRole('link', { name: /^ひばり工房 今日やることを読めませんでした$/ })).toHaveAttribute(
    'href',
    '/hibari',
  );
  await expect(pane(page)).not.toContainText('今日やることはまだありません');
});

test('読めなかった組織の長い名前も、狭い幅で折り返す押せる行にする', async ({ page }) => {
  const name = 'ひばり工房の長い名前'.repeat(15);
  await mockOperation(page, myToday, {
    ...empty,
    failed_organizations: [{ slug: 'hibari', name, kind: 'team' }],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const link = pane(page).getByRole('link', { name: `${name} 今日やることを読めませんでした`, exact: true });
  await expect(link).toHaveAttribute('href', '/hibari');
  await expect(link).toHaveClass(/choice/);
  const box = await link.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test('上限の先が未読のときは、全組織に今日やることが無いと言い切らない', async ({ page }) => {
  await mockOperation(page, myToday, { ...empty, omitted_organizations: 2 });
  await page.goto('/');
  await expect(pane(page)).toContainText('ほか 2 組織は読み込んでいません');
  await expect(pane(page)).toContainText('読み込んだ組織には今日やることがありません');
  await expect(pane(page)).not.toContainText('今日やることはまだありません');
});

test('今日の応答が遅くても組織とニュースを先に出し、面だけ骨組みで待つ', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task: OutputOf<typeof myToday>['tasks'][number] = {
    id: '019a0000-0000-7000-8000-000000000801',
    title: '応答を待ってから現れる今日の仕事',
    points: null,
    due_on: null,
    today_on: '2026-11-04',
    completed_at: null,
    workspace_id: '019a0000-0000-7000-8000-000000000401',
    workspace_name: '受託開発チーム',
    today: '2026-11-04',
    week_start: 1,
    position: 'a0',
    carry_days: 0,
    sprint_active: false,
    is_today_completed: false,
    reopenable: false,
    assignee: { id: '019a0000-0000-7000-8000-000000000301', name: 'ミナト' },
    delegatee: null,
    repository: null,
    sprint: null,
    organization: { slug: 'aoba', name: 'あおば開発', kind: 'team' },
  };
  await routeOperation(page, myToday, async (call) => {
    await gate;
    await call.fulfill({ ...empty, tasks: [task] });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('region', { name: '入れる組織', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Scrum Guild のニュース', exact: true })).toBeVisible();
    await expect(pane(page).locator('.pane-body')).toHaveAttribute('aria-busy', 'true');
    await expect(pane(page).locator('.skeleton')).toBeVisible();
    await expect(pane(page).getByRole('link', { name: task.title, exact: true })).toHaveCount(0);
    release();
    await expect(pane(page).getByRole('link', { name: task.title, exact: true })).toBeVisible();
    await expect(pane(page).locator('.pane-body')).not.toHaveAttribute('aria-busy', 'true');
    await expect(pane(page).locator('.skeleton')).toHaveCount(0);
  } finally {
    release();
  }
});

test('操作全体が失敗しても組織とニュースを残し、面内で再試行できる', async ({ page }) => {
  const restore = await failOperation(page, myToday, 500, 'internal');
  await page.goto('/');
  await expect(pane(page).getByRole('button', { name: 'もう一度試す', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '入れる組織', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Scrum Guild のニュース', exact: true })).toBeVisible();
  await expect(pane(page).getByRole('alert')).toHaveText('今日やることを読み込めませんでした');
  await expect(pane(page).locator('.callout.is-warn')).toBeVisible();
  const retry = pane(page).getByRole('button', { name: 'もう一度試す', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(pane(page).getByRole('status')).toHaveText('まだ読み込めませんでした');
  await restore();
  await mockOperation(page, myToday, empty);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(pane(page)).toContainText('今日やることはまだありません');
  await expect(pane(page).getByRole('heading', { level: 2 })).toBeFocused();
});
