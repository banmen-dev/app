// 全組織の今日やること。実際の API で2組織の本人タスクを作り、/ から詳細へ移れることを確かめる。
import { myOrganizations } from '../src/shared/operations/organization/my-organizations.ts';
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

const noOrganizationCases = [
  {
    name: '招待だけが届いている',
    data: {
      organizations: [],
      invitations: [{ slug: 'hibari', organization_name: 'ひばり工房' }],
      suspended: [],
      operator: false,
    },
    notice: 'まだ入れる組織がありません。届いた招待から組織を選び、承諾すると入れます。',
  },
  {
    name: '停止した組織だけがある',
    data: {
      organizations: [],
      invitations: [],
      suspended: [{ slug: 'hibari', name: 'ひばり工房', kind: 'team' }],
      operator: false,
    },
    notice: '停止している組織があります。下の「停止している組織」を見てください。',
  },
  {
    name: '初回で組織も招待も無い',
    data: { organizations: [], invitations: [], suspended: [], operator: false },
    notice: '管理者から招待が届くと、ここに出ます。',
  },
] satisfies { name: string; data: OutputOf<typeof myOrganizations>; notice: string }[];

for (const scenario of noOrganizationCases) {
  test(`${scenario.name}人には今日の面も要求も作らず、組織の案内とニュースを残す`, async ({ page }) => {
    await mockOperation(page, myOrganizations, scenario.data);
    let todayCalls = 0;
    await routeOperation(page, myToday, async (call) => {
      todayCalls++;
      await call.fulfill(empty);
    });
    await page.goto('/');
    const organizations = page.getByRole('region', { name: '組織', exact: true });
    await expect(organizations).toBeVisible();
    await expect(organizations).toContainText(scenario.notice);
    if (scenario.data.invitations.length > 0) {
      await expect(organizations.getByRole('link', { name: /ひばり工房/ })).toHaveAttribute(
        'href',
        '/hibari/invitations',
      );
    }
    if (scenario.data.suspended.length > 0) {
      await expect(page.getByRole('region', { name: '停止している組織', exact: true })).toContainText('ひばり工房');
    }
    await expect(page.getByRole('region', { name: 'Scrum Guild のニュース', exact: true })).toBeVisible();
    await expect(pane(page)).toHaveCount(0);
    expect(todayCalls).toBe(0);
  });
}

test('2組織の本人タスクを組織名とともに表示し、各組織の詳細へ移れる', async ({ page, browser, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await page.setViewportSize({ width: 390, height: 320 });
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
      await link.scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await link.click();
      await expect(page).toHaveURL(new URL(`/${task.slug}/w/${task.workspaceId}?task=${task.taskId}`, baseURL).href);
      await expect(page.getByRole('dialog', { name: task.title, exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    }
  } finally {
    // cleanup の検査失敗で元の失敗を隠さず、残りのタスクとワークスペースも片付ける。
    // ワークスペースを消すAPIは無いので終了する。CIのD1はジョブごとの使い捨て。
    for (const task of made) {
      const deleted = await page.request.post(`/api/${task.slug}/${taskDelete.name}`, {
        headers,
        data: { workspace_id: task.workspaceId, task_id: task.taskId },
      });
      expect.soft(deleted.status()).toBe(200);
    }
    for (const workspace of workspaces) {
      const closer = workspace.slug === 'aoba' ? page.request : otherAdmin.request;
      const closed = await closer.post(`/api/${workspace.slug}/${workspaceClose.name}`, {
        headers,
        data: { workspace_id: workspace.id },
      });
      expect.soft(closed.status()).toBe(200);
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
    await expect(page.getByRole('region', { name: '組織', exact: true })).toBeVisible();
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
  await expect(page.getByRole('region', { name: '組織', exact: true })).toBeVisible();
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
