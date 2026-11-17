// 全組織のダッシュボード（/）の、自分用の面、組織ごとのワークスペース、全組織の最近の更新（#1330、#1308）。
// 並びと出し分けは応答を差し替えて確かめ、組織をまたぐ読み取りは実際の API で2組織に作ったワークスペースとタスクで確かめる
import type { OutputOf } from '../src/shared/operations/define.ts';
import { myOrganizations } from '../src/shared/operations/organization/my-organizations.ts';
import { myRecentActivity } from '../src/shared/operations/organization/my-recent-activity.ts';
import { myToday } from '../src/shared/operations/organization/my-today.ts';
import { myWorkspaces } from '../src/shared/operations/organization/my-workspaces.ts';
import { organizationInfo } from '../src/shared/operations/organization/organization.ts';
import { taskCreate, taskDelete } from '../src/shared/operations/task/index.ts';
import {
  workspaceClose,
  workspaceCreate,
  workspaceLeaderCandidates,
} from '../src/shared/operations/workspace/index.ts';
import { expect, test } from './fixtures.ts';
import { findA11yViolations, findOverflowViolations, NARROW_VIEWPORT, signIn } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

const aoba = { slug: 'aoba', name: 'あおば開発', kind: 'team' as const };
const hibari = { slug: 'hibari', name: 'ひばり工房', kind: 'team' as const };
const personal = { slug: 'mio-solo', name: '自分用', kind: 'personal' as const };
const ids = {
  aobaWorkspace: '019a0000-0000-7000-8000-000000000a01',
  hibariWorkspace: '019a0000-0000-7000-8000-000000000a02',
  personalWorkspace: '019a0000-0000-7000-8000-000000000a03',
  task: '019a0000-0000-7000-8000-000000000a04',
};
const workspaces: OutputOf<typeof myWorkspaces> = {
  organizations: [
    {
      organization: personal,
      me_id: '019a0000-0000-7000-8000-000000000a10',
      workspaces: [{ id: ids.personalWorkspace, name: '読書の記録', role: 'leader' }],
    },
    {
      organization: aoba,
      me_id: '019a0000-0000-7000-8000-000000000a11',
      workspaces: [{ id: ids.aobaWorkspace, name: '受託開発チーム', role: 'leader' }],
    },
    { organization: hibari, me_id: '019a0000-0000-7000-8000-000000000a12', workspaces: [] },
  ],
  omitted_organizations: 0,
  failed_organizations: [],
};
const activity: OutputOf<typeof myRecentActivity> = {
  entries: [
    {
      id: '019a0000-0000-7000-8000-000000000a20',
      created_at: '2026-11-16T03:00:00.000Z',
      actor: { id: '019a0000-0000-7000-8000-000000000a10', name: 'ミナト' },
      workspace: { id: ids.personalWorkspace, name: '読書の記録' },
      target: { kind: 'task', id: ids.task, title: '第3章を読む' },
      event: { kind: 'comment', body: '半分まで読んだ。', truncated: false },
      organization: personal,
    },
    {
      id: '019a0000-0000-7000-8000-000000000a21',
      created_at: '2026-11-16T02:00:00.000Z',
      actor: { id: '019a0000-0000-7000-8000-000000000a11', name: 'ミナト' },
      workspace: { id: ids.aobaWorkspace, name: '受託開発チーム' },
      target: { kind: 'story', id: '019a0000-0000-7000-8000-000000000a05', title: '見積もりを整える' },
      event: { kind: 'create' },
      organization: aoba,
    },
  ],
  next: null,
  omitted_organizations: 0,
  failed_organizations: [],
};

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('自分用の面にワークスペースと作る入口、組織の面に組織ごとのワークスペース、右の列のニュースの上に最近の更新を出す', async ({
  page,
}) => {
  await mockOperation(page, myOrganizations, {
    organizations: [aoba, hibari, personal],
    invitations: [],
    suspended: [],
    operator: false,
  });
  await mockOperation(page, myWorkspaces, workspaces);
  await mockOperation(page, myRecentActivity, activity);
  await mockOperation(page, myToday, { tasks: [], omitted_organizations: 0, failed_organizations: [] });
  await page.goto('/');

  const personalPane = page.getByRole('region', { name: '自分用', exact: true });
  await expect(personalPane.getByRole('link', { name: /読書の記録/ })).toHaveAttribute(
    'href',
    `/mio-solo/w/${ids.personalWorkspace}`,
  );
  const create = personalPane.getByRole('button', { name: 'ワークスペースを作る', exact: true });
  await expect(create).toBeVisible();

  const organizations = page.getByRole('region', { name: '組織', exact: true });
  await expect(organizations.locator('.org-block > a.choice')).toHaveText([/あおば開発/, /ひばり工房/]);
  await expect(organizations.locator('.org-block > a.choice').first()).toHaveAttribute('href', '/aoba');
  await expect(organizations.getByRole('link', { name: /受託開発チーム/ })).toHaveAttribute(
    'href',
    `/aoba/w/${ids.aobaWorkspace}`,
  );
  await expect(organizations.locator('.org-block').nth(1)).toContainText('所属するワークスペースはありません。');
  await expect(page.getByText(/入れる組織が \d+ つあります/)).toHaveCount(0);

  // 自分用は左の列の先頭、組織の面、今日やることの順
  const mainPanes = page.locator('.dashboard-main > .pane > .pane-head > .pane-title');
  await expect(mainPanes).toHaveText(['自分用', '組織', '全組織の今日やること']);
  const sidePanes = page.locator('.dashboard-side > .pane > .pane-head > .pane-title');
  await expect(sidePanes).toHaveText(['最近の更新', 'Scrum Guild のニュース']);

  const activityPane = page.getByRole('region', { name: '最近の更新', exact: true });
  const first = activityPane.locator('.activity-row').first();
  await expect(first).toContainText('自分用');
  await expect(first).toContainText('読書の記録');
  await expect(first).toHaveAttribute('href', `/mio-solo/w/${ids.personalWorkspace}?task=${ids.task}`);
  await expect(activityPane.locator('.activity-row').nth(1)).toContainText('あおば開発');
  expect(await findA11yViolations(page)).toEqual([]);

  await create.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('狭い幅では1列に積み、左の列の面の下に最近の更新とニュースを置き、横にはみ出さない', async ({ page }) => {
  await mockOperation(page, myOrganizations, {
    organizations: [aoba, hibari, personal],
    invitations: [],
    suspended: [],
    operator: false,
  });
  await mockOperation(page, myWorkspaces, workspaces);
  await mockOperation(page, myRecentActivity, activity);
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/');
  const organizationsBox = await page.getByRole('region', { name: '組織', exact: true }).boundingBox();
  const activityBox = await page.getByRole('region', { name: '最近の更新', exact: true }).boundingBox();
  const newsBox = await page.getByRole('region', { name: 'Scrum Guild のニュース', exact: true }).boundingBox();
  expect(organizationsBox!.y).toBeLessThan(activityBox!.y);
  expect(activityBox!.y + activityBox!.height).toBeLessThanOrEqual(newsBox!.y);
  expect(await findOverflowViolations(page)).toEqual([]);
});

test('チーム用だけの人の自分用の面には、自分用を作る入口を出す', async ({ page }) => {
  await mockOperation(page, myOrganizations, {
    organizations: [aoba],
    invitations: [],
    suspended: [],
    operator: false,
  });
  await mockOperation(page, myWorkspaces, { ...workspaces, organizations: [workspaces.organizations[1]!] });
  await page.goto('/');
  const personalPane = page.getByRole('region', { name: '自分用', exact: true });
  await expect(personalPane.getByRole('button', { name: '自分用を作る', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '自分用を作る', exact: true })).toHaveCount(1);
});

test('ワークスペースを読めないときも組織の行は押せ、もう一度試すと出る', async ({ page }) => {
  await mockOperation(page, myOrganizations, {
    organizations: [aoba],
    invitations: [],
    suspended: [],
    operator: false,
  });
  const restore = await failOperation(page, myWorkspaces, 500, 'internal');
  await page.goto('/');
  const organizations = page.getByRole('region', { name: '組織', exact: true });
  await expect(organizations.getByRole('alert')).toHaveText('ワークスペースを読み込めませんでした。');
  await expect(organizations.locator('.org-block > a.choice')).toHaveAttribute('href', '/aoba');
  await restore();
  await mockOperation(page, myWorkspaces, { ...workspaces, organizations: [workspaces.organizations[1]!] });
  await organizations.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(organizations.getByRole('link', { name: /受託開発チーム/ })).toBeVisible();
  await expect(organizations.getByRole('alert')).toHaveCount(0);
});

test('自分用の面に自分用のホームへの行を置き、自分用だけで招待がある人は組織の面に招待を出して、招待の面を重ねない', async ({
  page,
}) => {
  await mockOperation(page, myOrganizations, {
    organizations: [personal],
    invitations: [{ slug: 'hibari', organization_name: 'ひばり工房' }],
    suspended: [],
    operator: false,
  });
  await mockOperation(page, myWorkspaces, { ...workspaces, organizations: [workspaces.organizations[0]!] });
  await page.goto('/');
  const personalPane = page.getByRole('region', { name: '自分用', exact: true });
  await expect(personalPane.locator('.org-block > a.choice')).toHaveAttribute('href', '/mio-solo');
  await expect(personalPane.getByRole('list', { name: '自分用で所属するワークスペース', exact: true })).toBeVisible();
  const organizations = page.getByRole('region', { name: '組織', exact: true });
  await expect(organizations.getByRole('link', { name: /ひばり工房/ })).toHaveAttribute('href', '/hibari/invitations');
  await expect(page.getByRole('region', { name: '届いた招待', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '自分用を作る', exact: true })).toHaveCount(0);
});

test('自分用が停止していてチーム用に入れる人には、自分用の面も「自分用を作る」も出さない', async ({ page }) => {
  await mockOperation(page, myOrganizations, {
    organizations: [aoba],
    invitations: [],
    suspended: [{ ...personal, slug: 'mio-stopped' }],
    operator: false,
  });
  await mockOperation(page, myWorkspaces, { ...workspaces, organizations: [workspaces.organizations[1]!] });
  await page.goto('/');
  await expect(
    page.getByRole('region', { name: '組織', exact: true }).getByRole('link', { name: /受託開発チーム/ }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: '自分用', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '自分用を作る', exact: true })).toHaveCount(0);
});

test('組織を読めなかった画面から「もう一度試す」で戻ると、ワークスペースも読む', async ({ page }) => {
  const restore = await failOperation(page, myOrganizations, 500, 'internal');
  await mockOperation(page, myWorkspaces, { ...workspaces, organizations: [workspaces.organizations[1]!] });
  await page.goto('/');
  const retry = page.getByRole('button', { name: 'もう一度試す', exact: true });
  await expect(retry).toBeVisible();
  await restore();
  await mockOperation(page, myOrganizations, {
    organizations: [aoba],
    invitations: [],
    suspended: [],
    operator: false,
  });
  await retry.click();
  await expect(
    page.getByRole('region', { name: '組織', exact: true }).getByRole('link', { name: /受託開発チーム/ }),
  ).toBeVisible();
});

test('自分用にワークスペースを作った後の読み直しが失敗しても、前に読んだ一覧を残して知らせる', async ({ page }) => {
  await mockOperation(page, myOrganizations, {
    organizations: [aoba, personal],
    invitations: [],
    suspended: [],
    operator: false,
  });
  let reads = 0;
  await routeOperation(page, myWorkspaces, async (call) => {
    reads++;
    if (reads === 1) await call.fulfill({ ...workspaces, organizations: workspaces.organizations.slice(0, 2) });
    else await call.fail(500, 'internal');
  });
  await mockOperation(
    page,
    workspaceLeaderCandidates,
    { slug: personal.slug },
    {
      users: [{ id: workspaces.organizations[0]!.me_id, name: 'ミナト' }],
    },
  );
  await mockOperation(
    page,
    workspaceCreate,
    { slug: personal.slug },
    { workspace_id: '019a0000-0000-7000-8000-000000000a30' },
  );
  await page.goto('/');
  const personalPane = page.getByRole('region', { name: '自分用', exact: true });
  await personalPane.getByRole('button', { name: 'ワークスペースを作る', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名前').fill('家の用事');
  await dialog.getByRole('button', { name: '作る', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'ワークスペースを作りました', exact: true })).toBeVisible();
  await expect.poll(() => reads).toBe(2);
  await expect(personalPane.getByRole('alert')).toHaveText(
    'ワークスペースの一覧を新しくできませんでした。前に読んだ一覧を出しています。',
  );
  await expect(personalPane.getByRole('link', { name: /読書の記録/ })).toBeVisible();
  await expect(
    page.getByRole('region', { name: '組織', exact: true }).getByRole('link', { name: /受託開発チーム/ }),
  ).toBeVisible();
});

test('2組織に作ったワークスペースが組織ごとに並び、最近の更新に組織の名前つきで出て、押すと詳細が開く', async ({
  page,
  browser,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const headers = { Origin: new URL(baseURL).origin };
  const otherAdmin = await browser.newContext({ baseURL });
  await signIn(otherAdmin, baseURL, 'otherOrg');
  const made: { slug: string; workspaceId: string; workspaceName: string; taskId: string; title: string }[] = [];
  try {
    for (const slug of ['aoba', 'hibari']) {
      const infoResponse = await page.request.post(`/api/${slug}/${organizationInfo.name}`, { headers, data: {} });
      expect(infoResponse.status()).toBe(200);
      const info = organizationInfo.output.parse(await infoResponse.json());
      const creator = slug === 'aoba' ? page.request : otherAdmin.request;
      const workspaceName = `${slug} のダッシュボード ${crypto.randomUUID().slice(0, 8)}`;
      const workspaceResponse = await creator.post(`/api/${slug}/${workspaceCreate.name}`, {
        headers,
        data: { name: workspaceName, timezone: 'Asia/Tokyo', leader_user_id: info.me.id },
      });
      expect(workspaceResponse.status()).toBe(200);
      const { workspace_id: workspaceId } = workspaceCreate.output.parse(await workspaceResponse.json());
      const title = `${slug} の最近の更新 ${crypto.randomUUID()}`;
      const created = await page.request.post(`/api/${slug}/${taskCreate.name}`, {
        headers,
        data: { workspace_id: workspaceId, title, assignee_user_id: info.me.id },
      });
      expect(created.status()).toBe(200);
      const { task } = taskCreate.output.parse(await created.json());
      made.push({ slug, workspaceId, workspaceName, taskId: task.id, title });
    }

    await page.goto('/');
    const organizations = page.getByRole('region', { name: '組織', exact: true });
    const activityPane = page.getByRole('region', { name: '最近の更新', exact: true });
    for (const item of made) {
      const name = item.slug === 'aoba' ? 'あおば開発' : 'ひばり工房';
      const block = organizations.locator('.org-block').filter({ hasText: name });
      await expect(block.getByRole('link', { name: new RegExp(item.workspaceName) })).toHaveAttribute(
        'href',
        `/${item.slug}/w/${item.workspaceId}`,
      );
      const row = activityPane.locator('.activity-row').filter({ hasText: item.title });
      await expect(row).toContainText(name);
      await expect(row).toContainText(item.workspaceName);
    }

    const target = made[1]!;
    await activityPane.locator('.activity-row').filter({ hasText: target.title }).click();
    await expect(page).toHaveURL(
      new URL(`/${target.slug}/w/${target.workspaceId}?task=${target.taskId}`, baseURL).href,
    );
    await expect(page.getByRole('dialog', { name: target.title, exact: true })).toBeVisible();
  } finally {
    for (const item of made) {
      const deleted = await page.request.post(`/api/${item.slug}/${taskDelete.name}`, {
        headers,
        data: { workspace_id: item.workspaceId, task_id: item.taskId },
      });
      expect.soft(deleted.status()).toBe(200);
      const closer = item.slug === 'aoba' ? page.request : otherAdmin.request;
      const closed = await closer.post(`/api/${item.slug}/${workspaceClose.name}`, {
        headers,
        data: { workspace_id: item.workspaceId },
      });
      expect.soft(closed.status()).toBe(200);
    }
    await otherAdmin.close();
  }
});
