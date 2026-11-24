<script lang="ts">
  import { resolve } from '$app/paths';
  import { GO_KEYS, isNavItemCurrent, visibleWorkspaceTabs } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';

  // ワークスペースの画面の上のタブ（761px 以上）。kit.js の workspaceTabsHtml と同じ作り。
  // 画面を移るリンクの並びなので、tablist（.tabs と aria-selected）ではなく nav の中のリンクにし、今の画面に aria-current="page" を付ける。
  // 項目と並びと出す条件は nav.ts の workspaceTabs（設定は対象のリーダーと管理者だけ）。今の画面の判定はパンくずと同じ isNavItemCurrent で、
  // タスクとエピックの詳細ではどれも選ばず、Wiki の下の階層（ページ）では Wiki を選ぶ。
  // 置き場所は AppShell のパンくずの帯（.sheet-crumbs）の下、本文（main）の外。760px 以下は出さない（スマホのタブは #1516）
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
    })),
  );

  // 幅が足りず帯の中で横に送るとき（左のメニューを広げた 761〜850px ほど）、今の画面のタブが帯の外に隠れないよう、
  // 開いたときと画面を移るたびに帯の見える範囲へ送る。帯の横の送りだけを変え、ページの縦の位置は動かさない（scrollIntoView を使わない）
  // 送るのは今の画面（パス）が替わったときだけ。current は親の page.url を読む getter なので、そのまま読むと
  // `?task=` などのクエリが替わるたびに走り直し、帯の位置を測る読み出しが引き出しの出現の動き（CSS の transition）を潰す。
  // $derived は値が同じなら下流へ知らせないので、パスが替わったときだけ走る
  const path = $derived(current);
  let bar = $state<HTMLElement>();
  $effect(() => {
    void path;
    const tab = bar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!bar || !tab) return;
    // 帯（position: relative）がタブの offsetParent なので、offsetLeft は帯の左端からの位置
    const start = tab.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start < bar.scrollLeft) bar.scrollLeft = start;
    else if (end > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = end - bar.clientWidth;
  });
</script>

<nav bind:this={bar} class="route-tabs" aria-label={t('workspaceTabs', { workspace: t('workspace') })}>
  {#each tabs as tab (tab.label)}
    <a
      class="route-tab"
      href={tab.link}
      data-label={t(tab.label)}
      aria-current={isNavItemCurrent(tab.label, tab.link, current) ? 'page' : undefined}
      aria-describedby={GO_KEYS[tab.label] === undefined ? undefined : `tab-go-${tab.label}`}>{t(tab.label)}</a
    >
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
</nav>
