<script lang="ts">
  import { tick } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import {
    NAV_MENU_ID,
    NAV_WORKSPACES_ID,
    navWorkspacesState,
    setNavWorkspacesCollapsed,
  } from '../nav-collapse.svelte.ts';
  import { GO_KEYS, favoriteNavItem, isNavItemCurrent, isWorkspaceId, isWorkspaceRoute, visibleNav } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { organizationLabel } from '../organization-label.ts';
  import type { NavigationWorkspace } from '../workspace-navigation.svelte.ts';
  import Icon from './Icon.svelte';
  import FavoriteLoadStatus from './FavoriteLoadStatus.svelte';
  import { useFavorites } from '../favorites.svelte.ts';
  const favorites = useFavorites();

  // kit.js の navHtml。current は今の画面のパス、slug は今の組織。画面のある項目だけを出す（nav.ts の visibleNav）。
  // アカウントと組織の入口は上の帯の AccountMenu に置く。所属するワークスペースが無い人（hasWorkspace が偽）には、組織の画面だけを出す。
  // workspace（メニューの対象）があれば、組織の画面でも「ワークスペース」の節を出す。見出しは畳めるボタンで、下に所属するワークスペースを
  // 名前順に並べ、押すとそのバックログへ移る（#1515）。所属していない管理者が開いているものは、一覧の先頭に押せない行で出す。
  // 畳んだ状態は端末に覚える（nav-collapse.svelte.ts）。畳むのは一覧だけで、760px 以下の浮きメニューの機能の項目は畳まない。
  // ワークスペースの経路の項目（メンバーなど）は、対象の ID があるときだけ出す。
  // 組織の切り替えはメニューの外（AppShell のブランドの下）に置く。
  // ワークスペースの設定は、対象のリーダーと管理者にだけ出す。
  // inWorkspaceScreen が偽（「今日やること」など組織の画面）のときは、対象の行にチェックだけを付け、現在地（aria-current）にはしない。
  // 現在地（aria-current）は、workspaceItems が真（760px 以下の浮きメニュー）では機能の項目だけが伝える（対象の行も同じ宛先で、
  // 両方に付けると現在地が二重に読み上げられるため）。行は目に見えない「（開いている）」で伝え、チェックは見た目に残す。
  // workspaceItems が偽（761px 以上の左のメニュー）なら、ワークスペースの機能の項目と「管理」の見出しを出さない。
  // 機能はワークスペースの画面の上のタブ（WorkspaceTabs）で切り替える。ワークスペースの見出しと一覧は残す
  let {
    current,
    slug,
    hasWorkspace,
    isAdmin,
    workspace,
    workspaces = [],
    inWorkspaceScreen,
    workspaceItems = true,
  }: {
    current: string;
    slug: string;
    hasWorkspace: boolean;
    isAdmin: boolean;
    workspace?: NavigationWorkspace;
    workspaces?: readonly { id: string; name: string }[];
    inWorkspaceScreen: boolean;
    workspaceItems?: boolean;
  } = $props();

  const favoriteLinks = $derived(
    (favorites?.items ?? [])
      .map((favorite) => ({ favorite, item: favoriteNavItem(resolve('/[slug]', { slug }), favorite) }))
      .filter(({ item }) => item.href !== null),
  );

  let workspaceToggle = $state<HTMLButtonElement>();
  let workspaceList = $state<HTMLUListElement>();

  // 別のタブで畳まれると一覧が hidden になり、中にあったフォーカスは body に落ちる。DOM に当てる前に中にあったかを見て、
  // 見出しのボタンへ移す（左のメニュー全体の開閉の AppShell と同じ形。このボタンで畳んだときはフォーカスがボタンにあるので当たらない）
  $effect.pre(() => {
    if (!navWorkspacesState.collapsed || !workspaceList?.contains(document.activeElement)) return;
    void tick().then(() => workspaceToggle?.focus());
  });

  const isMember = $derived(workspace !== undefined && workspaces.some((entry) => entry.id === workspace.id));

  const sections = $derived(
    visibleNav(undefined, {
      hasWorkspace,
      isAdmin,
      isLeader: workspace?.role === 'leader',
      hasWorkspaceMenu: workspace !== undefined,
      workspaceId: workspace?.id ?? null,
      workspaceItems,
    }),
  );
</script>

<nav class="nav" id={NAV_MENU_ID}>
  {#each sections as section (section.heading ?? 'organization')}
    {#if section.slot === 'workspace' && workspace}
      {@const collapsed = navWorkspacesState.collapsed}
      <div class="nav-group is-toggle">
        <button
          class="nav-group-toggle"
          type="button"
          aria-expanded={!collapsed}
          aria-controls={NAV_WORKSPACES_ID}
          bind:this={workspaceToggle}
          aria-label={t('workspaceListToggleLabel', { workspace: t('workspace') })}
          onclick={() => setNavWorkspacesCollapsed(!collapsed)}
        >
          <Icon name="chevron" /><span class="nav-group-label">{t('workspace')}</span>
        </button>
      </div>
      <ul
        class="nav-ws-list"
        id={NAV_WORKSPACES_ID}
        aria-label={t('workspaceNavListLabel', { workspace: t('workspace') })}
        hidden={collapsed}
        bind:this={workspaceList}
      >
        {#if !isMember}
          <!-- 所属していない管理者が開いているものは、移動先に加えず、押せない行で先頭に出す。長い名前は折り返して全文を見せる -->
          <li>
            <span class="nav-item is-current" aria-current={workspaceItems ? undefined : 'page'} title={workspace.name}>
              <span class="nav-item-label">{workspace.name}</span><Icon name="check" />{#if workspaceItems}<span
                  class="visually-hidden">{t('workspaceNavOpened')}</span
                >{/if}
            </span>
          </li>
        {/if}
        {#each workspaces as entry (entry.id)}
          {@const isCurrent = entry.id === workspace.id}
          <li data-name={entry.name}>
            <a
              class="nav-item"
              href={resolve('/[slug]/w/[id]', { slug, id: entry.id })}
              title={entry.name}
              aria-current={isCurrent && inWorkspaceScreen && !workspaceItems ? 'page' : undefined}
            >
              <span class="nav-item-label">{entry.name}</span>{#if isCurrent}<Icon
                  name="check"
                />{#if workspaceItems}<span class="visually-hidden">{t('workspaceNavOpened')}</span>{/if}{/if}
            </a>
          </li>
        {/each}
      </ul>
    {:else if section.heading}
      <div class="nav-group"><span class="nav-group-label">{t(section.heading)}</span></div>
    {/if}
    {#each section.items as item (item.label)}
      <!-- ワークスペースの経路は、ID が無ければ行き先が決まらないので描かない（visibleNav も同じ条件で外す） -->
      {@const href = isWorkspaceRoute(item.href)
        ? isWorkspaceId(workspace?.id)
          ? resolve(item.href, { slug, id: workspace.id })
          : null
        : resolve(item.href, { slug })}
      {#if href !== null}
        <a
          class="nav-item"
          class:is-wrapping={item.label === 'orgWiki'}
          {href}
          aria-describedby={GO_KEYS[item.label] === undefined ? undefined : `nav-go-${item.label}`}
          aria-current={isNavItemCurrent(item.label, href, current) ? 'page' : undefined}
        >
          <Icon name={item.icon} /><span class="nav-item-label"
            >{item.label === 'orgWiki'
              ? t('orgWiki', {
                  organization: page.data.organization ? organizationLabel(page.data.organization.organization) : '',
                })
              : t(item.label)}</span
          >
        </a>
        {#if GO_KEYS[item.label] !== undefined}
          <!-- 続けて押すキーは aria-keyshortcuts に書けないので、リンクの説明として伝える（目には見せない） -->
          <span class="visually-hidden" id="nav-go-{item.label}"
            >{t('shortcutGoHint', {
              first: GO_KEYS[item.label]!.split(' ')[0],
              next: GO_KEYS[item.label]!.split(' ')[1],
            })}</span
          >
        {/if}
      {/if}
    {/each}
    {#if section.heading === undefined && favorites && (favorites.loadFailed || favorites.loading || !favorites.available || favoriteLinks.length > 0)}
      <div class="nav-favorites">
        <div class="nav-group"><span class="nav-group-label">{t('favorites')}</span></div>
        <FavoriteLoadStatus
          onrecovered={() =>
            (
              document.getElementById(NAV_MENU_ID)?.querySelector<HTMLAnchorElement>('.nav-favorites a') ??
              document.getElementById(NAV_MENU_ID)?.querySelector<HTMLAnchorElement>('.nav-item')
            )?.focus()}
        />
        {#each favoriteLinks as { favorite, item } (`${favorite.target_type}/${favorite.target_id}`)}
          {#if item.href !== null}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- favoriteNavItem は resolve 済みの組織パスにエンコードした対象だけを足す -->
            <a class="nav-item" href={item.href} title={favorite.title}>
              <Icon name={item.icon} /><span class="nav-item-label">{favorite.title}</span>
            </a>
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
</nav>
