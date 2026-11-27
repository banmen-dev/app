<script lang="ts">
  import { tick } from 'svelte';
  import { resolve } from '$app/paths';
  import { GO_KEYS, isNavItemCurrent, visibleWorkspaceTabs } from '../nav.ts';
  import { fitTabCount } from '../tab-fit.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import { SwitcherMenu } from './switcher-menu.svelte.ts';

  // ワークスペースの画面の上のタブ（どの幅でも出す）。kit.js の workspaceTabsHtml と同じ作り。
  // 画面を移るリンクの並びなので、tablist（.tabs と aria-selected）ではなく nav の中のリンクにし、今の画面に aria-current="page" を付ける。
  // 項目と並びと出す条件は nav.ts の workspaceTabs（設定は対象のリーダーと管理者だけ）。今の画面の判定はパンくずと同じ isNavItemCurrent で、
  // タスクとエピックの詳細ではどれも選ばず、Wiki の下の階層（ページ）では Wiki を選ぶ。
  // 置き場所は AppShell の本文（main）の外、見出しの上。761px 以上はパンくずの帯（.sheet-crumbs）の下、760px 以下は上の帯の下（#1516）。
  // 幅が足りないときは、入るだけを前から並べ、残りを「その他 <件数>」のボタンにまとめる（Jira の狭い幅と同じ）。入る数は、
  // 全部のタブと「その他」のボタンを見えない場所に並べて測った幅（measurer）と帯の幅から fitTabCount で決め、帯か測った幅が変わるたびに決め直す
  // （幅を広げるとまとめていたタブが列に戻る）。測るまでは全部を並べて、はみ出す分を隠す。
  // 今の画面のタブが「その他」に入るときは、ボタンを今のタブと同じ印にして読み上げの名前でも伝え、開いた一覧の中のその項目に aria-current="page" を付ける。
  // 一覧はボタンの下に開き、組織の切り替えと同じ SwitcherMenu で、Esc、外を押す、Tab で外へ出る、項目を押すと閉じる
  let {
    current,
    slug,
    workspaceId,
    isAdmin,
    isLeader,
  }: { current: string; slug: string; workspaceId: string; isAdmin: boolean; isLeader: boolean } = $props();

  const tabs = $derived(
    visibleWorkspaceTabs({ isAdmin, isLeader }).map((tab) => ({
      ...tab,
      link: resolve(tab.href, { slug, id: workspaceId }),
      isCurrent: isNavItemCurrent(tab.label, resolve(tab.href, { slug, id: workspaceId }), current),
    })),
  );

  let bar = $state<HTMLElement>();
  let measurer = $state<HTMLElement>();
  // 列に残す数。null は測る前（全部を並べる）
  let fitCount = $state<number | null>(null);

  const shownCount = $derived(fitCount === null ? tabs.length : Math.min(fitCount, tabs.length));
  const shown = $derived(tabs.slice(0, shownCount));
  const rest = $derived(tabs.slice(shownCount));
  const restHasCurrent = $derived(rest.some((tab) => tab.isCurrent));

  const listId = $props.id();
  const menu = new SwitcherMenu();

  function measure(): void {
    if (!bar || !measurer) return;
    const items = [...measurer.querySelectorAll<HTMLElement>('[data-measure-tab]')];
    const more = measurer.querySelector<HTMLElement>('[data-measure-more]');
    if (items.length === 0 || !more) return;
    const gap = Number.parseFloat(getComputedStyle(measurer).columnGap) || 0;
    const next = fitTabCount(
      items.map((item) => item.getBoundingClientRect().width),
      bar.getBoundingClientRect().width,
      gap,
      more.getBoundingClientRect().width,
    );
    // 一覧の項目や列のタブにフォーカスがあるまま数が変わると、その要素が消えてフォーカスが body に落ちる。落ちたら、帯の中の今の画面か先頭のリンクへ移す
    const hadFocus = bar.contains(document.activeElement);
    fitCount = next;
    if (hadFocus)
      void tick().then(() => {
        if (bar && !bar.contains(document.activeElement))
          (
            bar.querySelector<HTMLElement>('a.route-tab[aria-current="page"]') ??
            bar.querySelector<HTMLElement>('a.route-tab')
          )?.focus();
      });
  }

  // 帯の幅、測る側の幅（文字の読み込みや拡大で変わる）、タブの数（ロールで設定が増減する）のどれかが変わったら決め直す
  // 依存は数だけにする。`tabs` そのものを読むと、今の画面が替わるたび（`?task=` の引き出しの出現など）に測り直し、位置を測る読み出しが CSS の transition を潰す
  const tabCount = $derived(tabs.length);
  $effect(() => {
    void tabCount;
    if (!bar || !measurer) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    observer.observe(measurer);
    return () => observer.disconnect();
  });

  // 画面を移ったときと、まとめるタブが無くなったとき（幅を広げた）は一覧を閉じる。移った先にフォーカスを残す（移る前の項目は消える）
  const path = $derived(current);
  $effect(() => {
    void path;
    menu.open = false;
  });
  $effect(() => {
    if (rest.length === 0) menu.open = false;
  });
</script>

<svelte:window onkeydown={menu.onkeydown} onclick={menu.onclick} />

<nav bind:this={bar} class="route-tabs" aria-label={t('workspaceTabs', { workspace: t('workspace') })}>
  {#each shown as tab (tab.label)}
    <a
      class="route-tab"
      href={tab.link}
      data-label={t(tab.label)}
      aria-current={tab.isCurrent ? 'page' : undefined}
      aria-describedby={GO_KEYS[tab.label] === undefined ? undefined : `tab-go-${tab.label}`}>{t(tab.label)}</a
    >
  {/each}
  {#if rest.length > 0}
    <div class="route-tab-more" bind:this={menu.root} onfocusout={menu.onfocusout}>
      <button
        class="route-tab"
        type="button"
        data-label="{t('workspaceTabsMore')} {rest.length}"
        data-current={restHasCurrent ? 'true' : undefined}
        aria-expanded={menu.open}
        aria-controls={listId}
        aria-label={restHasCurrent
          ? t('workspaceTabsMoreCurrent', { more: t('workspaceTabsMore'), count: String(rest.length) })
          : undefined}
        bind:this={menu.button}
        onclick={menu.toggle}
      >
        {t('workspaceTabsMore')} <span class="route-tab-count">{rest.length}</span><Icon name="chevron" />
      </button>
      <ul
        class="route-tabs-more-list"
        id={listId}
        aria-label={t('workspaceTabsMoreList', { workspace: t('workspace') })}
        hidden={!menu.open}
      >
        {#each rest as tab (tab.label)}
          <li>
            <a
              href={tab.link}
              aria-current={tab.isCurrent ? 'page' : undefined}
              aria-describedby={GO_KEYS[tab.label] === undefined ? undefined : `tab-go-${tab.label}`}
              onclick={menu.close}
              ><span class="route-tabs-more-name">{t(tab.label)}</span>{#if tab.isCurrent}<Icon name="check" />{/if}</a
            >
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#each tabs as tab (tab.label)}
    {#if GO_KEYS[tab.label] !== undefined}
      <!-- 続けて押すキーは aria-keyshortcuts に書けないので、リンクの説明として伝える（目には見せない。NavMenu と同じ） -->
      <span class="visually-hidden" id="tab-go-{tab.label}"
        >{t('shortcutGoHint', {
          first: GO_KEYS[tab.label]!.split(' ')[0],
          next: GO_KEYS[tab.label]!.split(' ')[1],
        })}</span
      >
    {/if}
  {/each}
  <!-- 幅を測るための見えない並び。全部のタブと、全部をまとめた件数の「その他」のボタンを、本物と同じ部品で置く -->
  <div class="route-tabs-measure" aria-hidden="true" bind:this={measurer}>
    {#each tabs as tab (tab.label)}
      <span class="route-tab-probe" data-measure-tab data-label={t(tab.label)}>{t(tab.label)}</span>
    {/each}
    <span class="route-tab-probe" data-measure-more data-label="{t('workspaceTabsMore')} {tabs.length}"
      >{t('workspaceTabsMore')} <span class="route-tab-count">{tabs.length}</span><Icon name="chevron" /></span
    >
  </div>
</nav>
