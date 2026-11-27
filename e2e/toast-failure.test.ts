// 失敗のトースト（左の縦線、成功より長く出る）と、URL を直接開いた最初の読み込みの表示（#boot-loading）を確かめる（#1004）。
// 失敗は今日やることの印の付け外しを 404 で断られて作る。seed のセッション（seed/sessions.ts）の Cookie で開く。
// 一般のユーザーはハルカ（あおば開発の受託開発チーム）、管理者はミナト。応答を差し替えるだけで、seed の行は書き換えない
import { organizationInfo, today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { backlogTree, taskTodayMark } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { shownBox, signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

const row: TodayTask = {
  id: '消えた行',
  title: '消えた行',
  points: null,
  due_on: '2026-11-06',
  today_on: null,
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
  assignee: null,
  delegatee: null,
  repository: null,
  sprint: null,
};

test('失敗のトーストは左に縦線が付き、成功の倍の 8 秒ほど出て、消えるときは抜ける動きが再生される', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.clock.install();
  // Svelte の out は Element.animate で動く。{#each} の項目の削除でも再生される（out:…|global）ことを、呼び出しの記録で確かめる
  await page.addInitScript(() => {
    const played: { opacity: unknown }[] = [];
    (window as unknown as { __played: typeof played }).__played = played;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList.contains('toast-leaving') && Array.isArray(keyframes)) {
        for (const frame of keyframes) played.push({ opacity: (frame as Keyframe).opacity });
      }
      return animate.call(this, keyframes, options);
    };
  });
  await routeOperation(page, today, { slug: 'aoba' }, (call) =>
    call.fulfill({ tasks: [{ ...row }], sprint_goals: [] }),
  );
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, (call) => call.fail(404, 'not_found'));
  await page.goto('/aoba');

  await page.getByRole('button', { name: '今日やる: 消えた行' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'このタスクは見つかりません' });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveClass(/is-failure/);
  // 左の縦線は 4px の実線。成功のトーストには付かない
  await expect(toast).toHaveCSS('border-inline-start-width', '4px');

  // 4 秒（成功の長さ）では消えない。8 秒で消える
  await page.clock.runFor(4_500);
  await expect(toast).toBeVisible();
  await page.clock.runFor(3_700);
  await expect(toast).toHaveCount(0);
  // 退場の再生は、消す時間切れの直後の描画の中で始まる。記録が付くのを待つ
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __played: unknown[] }).__played.length))
    .toBeGreaterThan(0);
});

// 指で押す画面（761px 以上）では、開閉のボタンが 44px、マークのリンクが 44px 幅になる。骨組みも同じ位置に置く（#1511）
for (const pointer of ['細かいポインター', '指で押す 1024px'] as const) {
  test.describe(pointer, () => {
    if (pointer === '指で押す 1024px')
      test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

    test(`URL を直接開いて木の読み込みが遅いとき、300ms 後に読み込み中の表示が出て、描けたら消える（${pointer}）`, async ({
      page,
      context,
      baseURL,
    }) => {
      await signIn(context, baseURL, 'admin');
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
        await gate;
        await call.passThrough();
      });
      await page.goto(WORKSPACE, { waitUntil: 'commit' });

      const boot = page.locator('#boot-loading');
      await expect(boot).toBeVisible();
      await expect(boot.locator('.boot-wait')).toHaveText('読み込んでいます');
      // 行き先が組織の枠なので、紙ではなく枠の形の骨組みを出す。左のメニューの幅と上の帯の高さは描いた後と同じ。
      // 本文はバックログの組み（絞り込みの行と木の行）
      await expect(boot.locator('.boot-frame')).toBeVisible();
      // 本文の上の余白は、上の帯の下のパンくずの帯が 16px を取り、本文はその下を 8px 空ける（#1509）
      await expect(boot.locator('.boot-crumbs')).toHaveCSS('padding-top', '16px');
      // ワークスペースの画面なので、パンくずの下にタブの帯を置き、本文はその下を 16px 空ける（#1514）
      await expect(page.locator('html')).toHaveAttribute('data-boot-tabs', 'true');
      await expect(boot.locator('.boot-tabs')).toBeVisible();
      await expect(boot.locator('.boot-content')).toHaveCSS('padding-top', '16px');
      await expect(page.locator('html')).toHaveAttribute('data-boot', 'tree');
      await expect(boot.locator('.boot-body .boot-row .is-select')).toHaveCount(4);
      await expect(boot.locator('.boot-skeleton')).toBeHidden();
      const bootBinding = await shownBox(boot.locator('.boot-binding'));
      const bootTopbar = await shownBox(boot.locator('.boot-topbar'));
      const bootHead = await shownBox(boot.locator('.boot-head'));
      const bootCrumbs = await shownBox(boot.locator('.boot-crumbs'));
      const bootTabs = await shownBox(boot.locator('.boot-tablist'));
      const bootMark = await shownBox(boot.locator('.boot-start .is-mark'));
      const bootToggle = await shownBox(boot.locator('.boot-start .is-toggle'));

      release();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(boot).toHaveCount(0);
      // 描いた後は、骨組みの形の印を html に残さない
      await expect(page.locator('html')).not.toHaveAttribute('data-boot');
      await expect(page.locator('html')).not.toHaveAttribute('data-boot-tabs');
      const binding = await shownBox(page.locator('.binding'));
      const topbar = await shownBox(page.locator('.topbar'));
      const head = await shownBox(page.locator('.page-head'));
      const crumbs = await shownBox(page.locator('.sheet-crumbs'));
      const tabs = await shownBox(page.locator('.route-tabs'));
      const mark = await shownBox(page.locator('.topbar-start .brand-art'));
      const toggle = await shownBox(page.locator('.nav-toggle'));
      expect(bootBinding.width).toBe(binding.width);
      // 上の帯は全幅で、左のメニューは帯の下から始まる（#1511）
      expect(bootTopbar.x).toBe(topbar.x);
      expect(bootTopbar.width).toBe(topbar.width);
      expect(bootTopbar.height).toBe(topbar.height);
      expect(bootBinding.y).toBe(binding.y);
      // 帯の左端のマークも、開閉のボタンの右の同じ位置にある
      expect(bootMark.x).toBe(mark.x);
      expect(bootMark.y).toBe(mark.y);
      expect(bootToggle).toEqual(toggle);
      // 指で押す画面の分岐に入ったこと: 本物の開閉のボタンは指で押す画面だけ 44px、細かいポインターでは 36px
      expect(toggle.width).toBe(pointer === '指で押す 1024px' ? 44 : 36);
      expect(toggle.height).toBe(toggle.width);
      // パンくずの帯も、上の帯の下の同じ位置と高さにある（#1509）
      expect(bootCrumbs.x).toBe(crumbs.x);
      expect(bootCrumbs.y).toBe(crumbs.y);
      expect(bootCrumbs.height).toBe(crumbs.height);
      // タブの帯も、パンくずの下の同じ位置と高さにある（#1514）
      expect(bootTabs.x).toBe(tabs.x);
      expect(bootTabs.y).toBe(tabs.y);
      expect(bootTabs.height).toBe(tabs.height);
      // 画面の見出しの始まりも同じ位置（本文の余白が本物と同じ）
      expect(bootHead.x).toBe(head.x);
      expect(bootHead.y).toBe(head.y);
    });
  });
}

for (const entry of ['URL を直接開く', 'ダッシュボードから移る'] as const) {
  test(`390px でバックログの題の位置が骨組みと揃う（${entry}）`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.setViewportSize({ width: 390, height: 844 });
    const direct = entry === 'URL を直接開く';
    if (!direct) await page.goto('/');

    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
      await gate;
      await call.passThrough();
    });
    const loadingHead = page.locator(
      direct ? '#boot-loading .boot-head' : '.loading-overlay [data-shape="tree"] .page-head',
    );
    let loadingTitle: Awaited<ReturnType<typeof shownBox>>;
    try {
      if (direct) await page.goto(WORKSPACE, { waitUntil: 'commit' });
      else await page.locator(`a.pane-link[href="${WORKSPACE}"]`).click();

      await expect(loadingHead).toBeVisible();
      await expect(loadingHead.locator('.is-eyebrow')).toHaveCount(0);
      loadingTitle = await shownBox(loadingHead.locator('.is-title'));
    } finally {
      release();
    }

    const title = page.getByRole('heading', { level: 1, name: 'バックログ' });
    await expect(title).toBeVisible();
    await expect(loadingHead).toHaveCount(0);
    expect(loadingTitle.y).toBeCloseTo((await shownBox(title)).y, 0);
  });
}

for (const activeSprint of [true, false]) {
  const title = activeSprint
    ? '進行中のボードは390pxで題が骨組みと揃い、760pxと761pxの境で骨組みの上の帯が切り替わる'
    : '進行中のスプリントが無いボードは390pxで読み込み後に小見出しが加わる';
  test(title, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.setViewportSize({ width: 390, height: 844 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, sprintBoard, { slug: 'aoba' }, async (call) => {
      await gate;
      await call.fulfill(activeSprint ? SAMPLE_BOARD : { ...SAMPLE_BOARD, sprint: null, columns: [] });
    });

    const boot = page.locator('#boot-loading');
    const loadingTitle = boot.locator('.boot-head .is-title');
    let loadingY: number;
    try {
      await page.goto(`${WORKSPACE}/board`, { waitUntil: 'commit' });
      await expect(loadingTitle).toBeVisible();
      await expect(boot.locator('.boot-head .is-eyebrow')).toHaveCount(0);
      loadingY = (await shownBox(loadingTitle)).y;

      if (activeSprint) {
        const topbar = boot.locator('.boot-topbar');
        await page.setViewportSize({ width: 760, height: 844 });
        await expect(topbar).toBeHidden();
        await page.setViewportSize({ width: 761, height: 844 });
        await expect(topbar).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
      }
    } finally {
      release();
    }

    const title = page.getByRole('heading', { level: 1, name: 'ボード' });
    const eyebrow = page.locator('.page-head .page-eyebrow');
    await expect(title).toBeVisible();
    await expect(boot).toHaveCount(0);
    if (activeSprint) {
      await expect(eyebrow).toHaveCount(0);
      expect((await shownBox(title)).y).toBeCloseTo(loadingY, 0);
    } else {
      await expect(eyebrow).toBeVisible();
      expect((await shownBox(title)).y).toBeGreaterThan(loadingY);
    }
  });
}

// 左のメニューを閉じたと覚えているときは、最初の読み込みの骨組みも、移る間の骨組み（LoadingSheet）も、
// 読み込んだ後と同じく左の列を出さず、本文を上の帯の下の全幅にする（#1512）
test('閉じた左のメニューでは、最初の読み込みと移る間の骨組みにも列が無く、本文の位置が描いた後と揃う', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('sg-nav-collapsed', 'true'));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.passThrough();
  });
  await page.goto(WORKSPACE, { waitUntil: 'commit' });

  const boot = page.locator('#boot-loading');
  await expect(boot.locator('.boot-frame')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-boot-nav', 'collapsed');
  await expect(boot.locator('.boot-binding')).toBeHidden();
  const bootSheet = await shownBox(boot.locator('.boot-sheet'));
  const bootHead = await shownBox(boot.locator('.boot-head'));
  const bootCrumbs = await shownBox(boot.locator('.boot-crumbs'));
  expect(bootSheet.x).toBe(0);

  release();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(boot).toHaveCount(0);
  await expect(page.locator('.app')).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(page.locator('.binding')).toBeHidden();
  const sheet = await shownBox(page.locator('.sheet'));
  const head = await shownBox(page.locator('.page-head'));
  const crumbs = await shownBox(page.locator('.sheet-crumbs'));
  expect(sheet.x).toBe(0);
  expect(bootSheet.width).toBe(sheet.width);
  expect(bootCrumbs.x).toBe(crumbs.x);
  expect(bootCrumbs.y).toBe(crumbs.y);
  expect(bootHead.x).toBe(head.x);
  expect(bootHead.y).toBe(head.y);

  // 枠の外（/）から組織へ移る間の骨組み（LoadingSheet）も、閉じた形のまま列を出さない
  await page.goto('/');
  let releaseOrganization: () => void = () => {};
  const organizationGate = new Promise<void>((resolve) => (releaseOrganization = resolve));
  await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
    await organizationGate;
    await call.passThrough();
  });
  await page
    .getByRole('region', { name: '組織', exact: true })
    .getByRole('link', { name: /あおば開発/ })
    .click();
  const frame = page.locator('.loading-overlay .skeleton-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('data-nav-collapsed', 'true');
  await expect(frame.locator('> .binding')).toBeHidden();
  expect((await shownBox(frame.locator('> .sheet'))).x).toBe(0);
  releaseOrganization();
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`15 秒たっても描けないときは、読み込み中の文を失敗の文と再読み込みのリンクに替える（${reducedMotion}）`, async ({
    page,
    context,
    baseURL,
  }) => {
    // CSS の animation-delay は page.clock では進まないので、実時間で 15 秒待つ
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion });
    await signIn(context, baseURL, 'admin');
    // 画面の JS が届かない（描けない）まま 15 秒たたせる。API の読み取りを止めると、10 秒で打ち切られて
    // 読み込みの失敗の画面が描かれ、#boot-loading が消える（src/lib/api.ts の READ_TIMEOUT_MS）。
    // 止めるのは JS だけにする。/_app/immutable/ の CSS まで止めると、#boot-loading が DOM に現れない（pnpm preview で確かめた）
    await page.route('**/_app/immutable/**/*.js', () => new Promise<void>(() => {}));
    await page.goto(WORKSPACE, { waitUntil: 'commit' });

    const boot = page.locator('#boot-loading');
    // 待つ文は読み上げ用に1pxへ隠す。見える骨組みと、15秒で替わるvisibilityを別に確かめる。
    await expect(boot.locator('.boot-frame')).toBeVisible();
    await expect(boot.locator('.boot-wait')).toHaveText('読み込んでいます');
    await expect(boot.locator('.boot-wait')).toHaveCSS('visibility', 'visible');
    await expect(boot.getByText('読み込めませんでした')).toBeHidden();
    await expect(boot.getByText('読み込めませんでした')).toBeVisible({ timeout: 20_000 });
    await expect(boot.locator('.boot-wait')).toHaveCSS('visibility', 'hidden');
    await expect(boot.locator('.boot-frame')).toBeHidden();
    await expect(boot.getByRole('link', { name: 'もう一度試す' })).toBeVisible();
  });
}

test('390px の失敗トーストは下のタブバーを覆わない（#1102）', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.setViewportSize({ width: 390, height: 844 });
  await routeOperation(page, today, { slug: 'aoba' }, (call) =>
    call.fulfill({ tasks: [{ ...row }], sprint_goals: [] }),
  );
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, (call) => call.fail(404, 'not_found'));
  await page.goto('/aoba');
  await page.getByRole('button', { name: '今日やる: 消えた行' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'このタスクは見つかりません' });
  await expect(toast).toBeVisible();
  const toastBox = await toast.boundingBox();
  const tabsBox = await page.locator('.mobile-tabs').boundingBox();
  expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(tabsBox!.y);
});
