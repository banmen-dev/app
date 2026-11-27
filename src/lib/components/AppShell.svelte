<script lang="ts">
  import CreateSheet from './LazyCreateSheet.svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import MobileNavigation from './MobileNavigation.svelte';
  import { navigationLoading } from '../navigation-loading.svelte.ts';
  import { onMount, setContext, tick, type Snippet } from 'svelte';
  import { PageHeadOwners } from '../page-head-owners.svelte.ts';
  import { MOBILE_PAGE_HEAD, type MobilePageHead } from '../mobile-page-head.ts';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import { NAV_MENU_ID, navState, setNavCollapsed } from '../nav-collapse.svelte.ts';
  import {
    NAV_WIDTH_MIN,
    draggedNavWidth,
    keyedNavWidth,
    releasedNavWidth,
    navWidthMax,
    navWidthState,
    setNavWidth,
  } from '../nav-width.svelte.ts';
  import { page } from '$app/state';
  import { accountScreenKey, workspaceIdOf } from '../breadcrumb.ts';
  import { goto, onNavigate } from '$app/navigation';
  import { shouldFadeNavigation, startNavigationFade } from '../navigation-fade.ts';
  import { prefersReducedMotion } from '../reduced-motion.ts';
  import { useShortcut } from '../shortcuts.svelte.ts';
  import { GO_KEYS, isNavItemCurrent, isWorkspaceId, isWorkspaceRoute, visibleNav } from '../nav.ts';
  import { organizationLabel } from '../organization-label.ts';
  import BrandSymbol from './BrandSymbol.svelte';
  import Breadcrumb from './Breadcrumb.svelte';
  import NavMenu from './NavMenu.svelte';
  import NavSearch from './NavSearch.svelte';
  import WorkspaceTabs from './WorkspaceTabs.svelte';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import Icon from './Icon.svelte';
  import type { NavigationWorkspace } from '../workspace-navigation.svelte.ts';

  const createSheetId = $props.id();
  let createSheet = $state<ReturnType<typeof CreateSheet>>();

  // kit.js の mount が組む画面の枠。全幅の上の帯（左端に開閉のボタンとマーク）の下に、
  // 左のメニュー（綴じ）と本文（帳面）が並ぶ。slug は今の組織で、組織の中の画面だけが使う。
  // 組織の切り替え（上の帯の右、アカウントの左。760px 以下は浮きメニューの先頭）、アシスタントのボタンは置き場所だけで、中身は snippet で渡す。
  // workspace はメニューの対象。「今日やること」など組織の画面でも渡す。
  // 761px 以上は、上の帯の左に開閉のボタンとマーク、右に検索、assistant、組織の切り替え、account を寄せて並べ、パンくず（組織 › ワークスペース › 画面）は本文の見出しの上の帯（.sheet-crumbs）に出す。
  // ワークスペースの画面では、パンくずの帯の下に機能のタブ（WorkspaceTabs、.sheet-tabs）を出し、左のメニューにはワークスペースの機能の項目を出さない（#1514）。
  // スマホは PageHead の右に検索と account を移し、PageHead が無い画面だけ代わりの見出しを置く
  let {
    current,
    slug,
    hasWorkspace,
    isAdmin,
    workspace,
    organizationSwitcher,
    workspaces,
    inWorkspaceScreen,
    assistant,
    account,
    notice,
    children,
  }: {
    current: string;
    slug: string;
    hasWorkspace: boolean;
    isAdmin: boolean;
    workspace?: NavigationWorkspace;
    organizationSwitcher?: Snippet;
    workspaces?: readonly { id: string; name: string }[];
    inWorkspaceScreen: boolean;
    assistant?: Snippet;
    account?: Snippet<[narrow?: boolean]>;
    notice?: Snippet<[narrow?: boolean]>;
    children: Snippet;
  } = $props();

  const narrow = new MediaQuery('(max-width: 760px)');
  const pageHeads = new PageHeadOwners();
  let mounted = $state(false);
  let navToggle = $state<HTMLButtonElement>();
  let binding = $state<HTMLElement>();

  // 左のメニューの右の境目（#1513）。ドラッグと左右の矢印キーで幅を変え、ダブルクリックと Enter で閉じる。
  // 幅の上限は画面の幅で変わる（min(480px, 40vw)）。覚えた幅が上限を超える細い窓では上限の幅で出し（CSS の clamp と同じ）、読み上げの値もそれに合わせる
  let viewportWidth = $state(0);
  const navWidthLimit = $derived(navWidthMax(viewportWidth));
  // width はドラッグの間だけの幅（ドラッグとみなす移動が無ければ null）。ドラッグの間は覚えた幅の状態（navWidthState）を書き換えず、
  // 見た目だけをこの幅で出す。別のタブが覚えた幅を変えても状態に入り、離したときに見える幅が掴んだときと変わらなければ
  // （押して離しただけ、上限に張り付いたまま動かした）何もしないので、覚えた広い幅も別のタブの変更も失わない
  let resize = $state<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number | null;
  } | null>(null);
  const navWidth = $derived(resize?.width ?? navWidthState.width);
  const shownNavWidth = $derived(Math.min(navWidth, navWidthLimit));
  // 札の縦の位置。ホバーではポインタの高さに出し、キーボードで移ったときは境目の上端に出す（CSS の既定）
  let resizeTipY = $state<number | null>(null);

  function onResizePointerDown(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    resize = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: shownNavWidth,
      width: null,
    };
  }
  function onResizePointerMove(event: PointerEvent) {
    if (resize && event.pointerId === resize.pointerId) {
      // ドラッグの間は見た目だけを変え、離したときに覚える（localStorage に動くたびに書かない）。
      // 閾値未満のずれは動かしていないものとし、一度ドラッグになった後は掴んだときの幅に戻す
      const next = draggedNavWidth(resize.startWidth, event.clientX - resize.startX, viewportWidth);
      if (next !== null || resize.width !== null) resize.width = next ?? resize.startWidth;
      return;
    }
    resizeTipY = event.clientY - (event.currentTarget as HTMLElement).getBoundingClientRect().top;
  }
  function onResizePointerEnd(event: PointerEvent) {
    if (!resize || event.pointerId !== resize.pointerId) return;
    const { startWidth, width } = resize;
    resize = null;
    const next = width === null ? null : releasedNavWidth(startWidth, width);
    if (next !== null) setNavWidth(next, { viewportWidth });
    // 離した直後も :hover のまま札が出るので、今のポインタの高さに合わせる（lostpointercapture は座標を持たないことがあるので、pointerup だけ）
    if (event.type === 'pointerup')
      resizeTipY = event.clientY - (event.currentTarget as HTMLElement).getBoundingClientRect().top;
  }
  // 境目を掴んで動かす間に、下にあるメニューのリンクのブラウザ標準のドラッグが始まると、pointercancel で境目の操作が打ち切られる
  // （リンクが境目の掴んだ高さに来るかは、メニューの中身で決まる）。リサイズの間はドラッグの開始を止める
  function onDragStart(event: DragEvent) {
    if (resize) event.preventDefault();
  }
  function onResizeKeydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      setNavCollapsed(true);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    // 端に張り付いて見た目が変わらないときは覚え直さない
    const next = keyedNavWidth(event.key, shownNavWidth, viewportWidth);
    if (next !== null) setNavWidth(next, { viewportWidth });
  }

  // 左のメニューを閉じると綴じが hidden になり、中にあったフォーカスは body に落ちる（別のタブで閉じたときなど。
  // 開閉のボタンで閉じたときはフォーカスがボタンにあるので当たらない）。DOM に当てる前に中にあったかを見て、開閉のボタンへ移す
  $effect.pre(() => {
    if (!navState.collapsed || !binding?.contains(document.activeElement)) return;
    void tick().then(() => navToggle?.focus());
  });

  // 760px 以下で別の画面へ移るとき、画面を短く入れ替える（View Transitions。タブバーは動かさない）。
  // onNavigate はデータの読み込みが済んだ後に呼ばれるので、読み込みの待ちには重ならない（前の画面の画像を撮る1フレームほどは遅れる）。
  onNavigate((navigation) => {
    if (
      !shouldFadeNavigation({
        narrow: narrow.current,
        reducedMotion: prefersReducedMotion(),
        supported: typeof document.startViewTransition === 'function',
        type: navigation.type,
        from: navigation.from?.url.pathname,
        to: navigation.to?.url.pathname,
      })
    )
      return;
    // 移る前の画面にはこの枠のタブバーがある。行き先にタブバーが無い（枠の外の画面へ出た）ときは、
    // 帯だけが先に消えて見えないよう、入れ替えずにそのまま見せる
    return startNavigationFade(
      navigation.complete,
      (update) => document.startViewTransition(update),
      () => document.querySelector('.mobile-navigation') !== null,
    );
  });
  onMount(() => {
    // 子の PageHead が登録を終えるまでは代わりの入口を描かない。
    void tick().then(() => {
      mounted = true;
    });
  });
  setContext<MobilePageHead>(MOBILE_PAGE_HEAD, {
    get narrow() {
      return narrow.current;
    },
    get tools() {
      return mobileTools;
    },
    register(id) {
      return pageHeads.register(id);
    },
    owns: (id) => pageHeads.owns(id),
  });

  // パンくず。ワークスペースは、ワークスペースの画面を開いているときだけ出す（組織の画面では、メニューの対象でも出さない）。
  // 画面の名前はメニューの項目から引き、メニューに無いアカウントのメニューの画面だけ別に引く
  const organizationName = $derived(
    page.data.organization ? organizationLabel(page.data.organization.organization) : t('organization'),
  );
  const openWorkspaceId = $derived(workspaceIdOf(current));
  const crumbWorkspace = $derived(
    openWorkspaceId !== null && isWorkspaceId(workspace?.id) && workspace.id === openWorkspaceId ? workspace : null,
  );
  // 画面の名前と行き先。パンくずの今の画面と、上の帯の検索の候補が同じ一覧を使う
  const navScreens = $derived.by(() => {
    const sections = visibleNav(undefined, {
      hasWorkspace,
      isAdmin,
      isLeader: workspace?.role === 'leader',
      hasWorkspaceMenu: crumbWorkspace !== null,
      workspaceId: crumbWorkspace?.id ?? null,
    });
    const screens: { key: DictionaryKey; label: string; href: string; aliases?: string[] }[] = [];
    for (const section of sections) {
      for (const item of section.items) {
        const href = isWorkspaceRoute(item.href)
          ? crumbWorkspace
            ? resolve(item.href, { slug, id: crumbWorkspace.id })
            : null
          : resolve(item.href, { slug });
        if (href === null) continue;
        screens.push({
          key: item.label,
          label: item.label === 'orgWiki' ? t('orgWiki', { organization: organizationName }) : t(item.label),
          href,
          // ボードは #1497 でスプリントの画面から改名した。「スプリント」と打っても候補に出す
          ...(item.label === 'board' ? { aliases: [t('sprint')] } : {}),
        });
      }
    }
    return screens;
  });
  // `g` の次のキーで、バックログ・ボード・今日やることへ移る（shortcuts.svelte.ts に登録する）。
  // バックログとボードは、メニューの対象のワークスペースがあるときだけ。今いる画面へは移らない
  const goHref = (key: 'backlog' | 'board' | 'pageToday'): string | null => {
    if (key === 'pageToday') return resolve('/[slug]', { slug });
    if (!isWorkspaceId(workspace?.id)) return null;
    return key === 'backlog'
      ? resolve('/[slug]/w/[id]', { slug, id: workspace.id })
      : resolve('/[slug]/w/[id]/board', { slug, id: workspace.id });
  };
  for (const key of ['backlog', 'board', 'pageToday'] as const) {
    useShortcut(() => ({
      id: `go-${key}`,
      keys: GO_KEYS[key]!,
      label: () => t('shortcutGo', { screen: t(key) }),
      global: true,
      helpOrder: 2,
      enabled: () => {
        const href = goHref(key);
        return href !== null && href !== current;
      },
      run: () => {
        if (key === 'pageToday') void goto(resolve('/[slug]', { slug }));
        else if (isWorkspaceId(workspace?.id))
          void goto(
            key === 'backlog'
              ? resolve('/[slug]/w/[id]', { slug, id: workspace.id })
              : resolve('/[slug]/w/[id]/board', { slug, id: workspace.id }),
          );
      },
    }));
  }
  // 検索から送るバックログ。ワークスペースの画面を開いているときだけ
  const backlogHref = $derived(crumbWorkspace ? resolve('/[slug]/w/[id]', { slug, id: crumbWorkspace.id }) : null);
  const screenName = $derived.by(() => {
    const found = navScreens.find((screen) => isNavItemCurrent(screen.key, screen.href, current));
    if (found) return found.label;
    const key = accountScreenKey(current, slug, isAdmin);
    return key ? t(key) : null;
  });
  const crumbs = $derived([
    { label: organizationName, href: resolve('/[slug]', { slug }) },
    ...(crumbWorkspace
      ? [{ label: crumbWorkspace.name, href: resolve('/[slug]/w/[id]', { slug, id: crumbWorkspace.id }) }]
      : []),
    ...(screenName ? [{ label: screenName, current: true }] : []),
  ]);
  // 画面の名前が決まらない画面（エピックやタスクの詳細など）では、最後の項目（ワークスペース）を今の画面として示す。リンクは残し、戻れるようにする
  const shownCrumbs = $derived(
    screenName ? crumbs : crumbs.map((crumb, i) => (i === crumbs.length - 1 ? { ...crumb, current: true } : crumb)),
  );
</script>

{#snippet mobileTools()}
  <div class="mobile-page-tools" role="group" aria-label={t('mobilePageToolsLabel')}>
    <NavSearch screens={navScreens} {backlogHref} />
    {#if account}{@render account(true)}{/if}
  </div>
{/snippet}

<svelte:window bind:innerWidth={viewportWidth} ondragstart={onDragStart} />

<!-- 幅は CSSOM（style:）で渡す。CSP が style 属性の文字列を止めるため（Avatar.svelte と同じ扱い） -->
<div
  class="app"
  data-nav-collapsed={navState.collapsed ? 'true' : undefined}
  data-nav-resizing={resize ? 'true' : undefined}
  style:--nav-width="{navWidth}px"
>
  {#if !narrow.current}
    <div class="topbar">
      <div class="topbar-start">
        <button
          bind:this={navToggle}
          class="nav-toggle"
          type="button"
          aria-expanded={!navState.collapsed}
          aria-controls={NAV_MENU_ID}
          aria-label={t(navState.collapsed ? 'menuExpand' : 'menuCollapse')}
          onclick={() => setNavCollapsed(!navState.collapsed)}
          onkeydown={(event) => {
            // 押し続けた Enter の繰り返しでは押さない。境目で Enter を押して閉じるとフォーカスがこのボタンへ移り、
            // 押し続けた繰り返しの Enter がここに届いて開き直してしまうため（#1513）
            // Space は keyup で押されるので、繰り返しの keydown では押されない。止めるのは Enter だけでよい
            if (event.repeat && event.key === 'Enter') event.preventDefault();
          }}
        >
          <Icon name="panel" />
          <span class="nav-tip" aria-hidden="true">{t(navState.collapsed ? 'menuExpand' : 'menuCollapse')}</span>
        </button>
        <a class="brand" href={resolve('/[slug]', { slug })}>
          <BrandSymbol />
          <span class="visually-hidden">{t('appName')}</span>
        </a>
      </div>
      <NavSearch screens={navScreens} {backlogHref} />
      {#if assistant}{@render assistant()}{/if}
      {#if organizationSwitcher}{@render organizationSwitcher()}{/if}
      {#if account}{@render account()}{/if}
    </div>
    <!-- 閉じている間も NavMenu は DOM に残し（開閉のボタンの aria-controls の先を保つ）、hidden でキーボードと読み上げから外す -->
    <aside class="binding" aria-label={t('menu')} hidden={navState.collapsed} bind:this={binding}>
      <div class="binding-inner">
        <div class="binding-body">
          <NavMenu
            {current}
            {slug}
            {hasWorkspace}
            {isAdmin}
            {workspace}
            {workspaces}
            {inWorkspaceScreen}
            workspaceItems={false}
          />
        </div>
      </div>
      <!-- 右の境目。ホバーのできない端末では CSS で出さない（開閉のボタンだけで閉じる）。
           フォーカスできる separator（値を持つ）は ARIA では操作できる部品だが、Svelte の検査は非対話の役割と見なすので外す -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="nav-resize"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label={t('navResize')}
        aria-controls={NAV_MENU_ID}
        aria-keyshortcuts="Enter"
        aria-valuenow={shownNavWidth}
        aria-valuemin={NAV_WIDTH_MIN}
        aria-valuemax={navWidthLimit}
        data-dragging={resize ? 'true' : undefined}
        style:--nav-resize-tip-y={resizeTipY === null ? undefined : `${resizeTipY}px`}
        onpointerdown={onResizePointerDown}
        onpointermove={onResizePointerMove}
        onpointerup={onResizePointerEnd}
        onpointercancel={onResizePointerEnd}
        onlostpointercapture={onResizePointerEnd}
        onpointerleave={() => (resizeTipY = null)}
        ondblclick={() => setNavCollapsed(true)}
        onkeydown={onResizeKeydown}
      >
        <span class="nav-resize-tip" aria-hidden="true">{t('navResizeTip')}</span>
      </div>
    </aside>
  {/if}
  <div class="sheet">
    {@render notice?.(narrow.current)}
    {#if !narrow.current}
      <div class="sheet-crumbs"><Breadcrumb crumbs={shownCrumbs} /></div>
      {#if crumbWorkspace}
        <div class="sheet-tabs">
          <WorkspaceTabs
            {current}
            {slug}
            workspaceId={crumbWorkspace.id}
            {isAdmin}
            isLeader={crumbWorkspace.role === 'leader'}
          />
        </div>
      {/if}
    {/if}
    <main class="content" id="content" aria-busy={navigationLoading.kind === 'inside' ? true : undefined}>
      {#if mounted && narrow.current && pageHeads.empty}
        <header class="mobile-page-head page-head-row">
          <h2 class="page-title">{shownCrumbs.at(-1)?.label}</h2>
          {@render mobileTools()}
        </header>
      {/if}
      {@render children()}
    </main>
  </div>
  {#if narrow.current}
    <MobileNavigation
      {createSheetId}
      oncreate={(trigger) => void createSheet?.show(trigger)}
      {current}
      {slug}
      workspaceId={hasWorkspace ? workspace?.id : undefined}
      {organizationSwitcher}
    >
      {#snippet menu()}
        <NavMenu {current} {slug} {hasWorkspace} {isAdmin} {workspace} {workspaces} {inWorkspaceScreen} />
      {/snippet}
    </MobileNavigation>
  {/if}
  {#if hasWorkspace && isWorkspaceId(workspace?.id)}
    {#key `${slug}/${workspace.id}`}<CreateSheet
        bind:this={createSheet}
        {slug}
        workspaceId={workspace.id}
        id={createSheetId}
      />{/key}
  {/if}
</div>
