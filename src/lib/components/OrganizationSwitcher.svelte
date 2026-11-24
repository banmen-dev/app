<script lang="ts">
  import { navigating } from '$app/state';
  import { resolve } from '$app/paths';
  import type { OrganizationKind } from '../../shared/organization-kind.ts';
  import { organizationLabel } from '../organization-label.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import { SwitcherMenu } from './switcher-menu.svelte.ts';

  // kit.js の orgMenuHtml。761px 以上は上の帯の右（アカウントの左）、760px 以下は浮きメニューの先頭に置く。
  // 開閉するメニューで、中は各組織へのリンクと、最後に組織の選択の画面（/）へ戻るリンク。
  // 選ぶと画面が移るので select にしない（矢印キーで選んだだけで移ってしまう）。
  // 閉じるのは、ボタン、メニューの外を押す、Tab でメニューの外へ出る、リンクを押す、Esc。
  // メニューの中にフォーカスがあるときに閉じたら、ボタンへフォーカスを戻す（隠れた要素にフォーカスを残さない）。
  // 今の組織の名前は、入れる組織の一覧の中の名前を使う。一覧に無いとき（取れなかった）だけ fallbackName を使う。
  // invited は、届いた招待があること。招待が見える入口は組織の選択の画面だけなので、ここで印を出す。
  // ダッシュボードへのリンクは組織の数によらず出す。作成ボタンは閉じた後も残る枠のダイアログを開く。
  let {
    organizations,
    currentSlug,
    fallbackName,
    invited,
    canCreatePersonal,
    oncreate,
    oncreatepersonal,
  }: {
    organizations: readonly { slug: string; name: string; kind: OrganizationKind }[];
    currentSlug: string;
    fallbackName: string;
    invited: boolean;
    // 入れる組織にも停止した組織にも自分用が無い人か（組織の選択の画面の「自分用を作る」と同じ条件。hasPersonalOrganization）
    canCreatePersonal: boolean;
    oncreate: (trigger: HTMLElement | null) => void;
    oncreatepersonal: (trigger: HTMLElement | null) => void;
  } = $props();

  const listId = $props.id();
  const menu = new SwitcherMenu();

  const currentName = $derived.by(() => {
    const current = organizations.find((item) => item.slug === currentSlug);
    return current === undefined ? fallbackName : organizationLabel(current);
  });
  // 今の組織から離れる移動（別の組織、組織の選択の画面）の最中
  const moving = $derived(
    navigating.to !== null && (navigating.to.route.id === '/' || navigating.to.params?.slug !== currentSlug),
  );
  // 名前の欄に出す文字。移っている最中は「移っています」
  const shownName = $derived(moving ? t('organizationMoving') : currentName);
  // 浮きメニューで見える「組織」、名前欄、招待の印を表示順に読み上げる（WCAG 2.5.3）。
  const invitationBadge = $derived(invited ? t('invitationsBadge') : '');
  const label = $derived(
    t('organizationSwitchLabel', { name: [t('organization'), shownName, invitationBadge].filter(Boolean).join(' ') }),
  );

  function create(): void {
    menu.close();
    oncreate(menu.button ?? null);
  }

  function createPersonal(): void {
    menu.close();
    oncreatepersonal(menu.button ?? null);
  }
</script>

<svelte:window onkeydown={menu.onkeydown} onclick={menu.onclick} />

<div class="org-menu" bind:this={menu.root} onfocusout={menu.onfocusout}>
  <button
    class="org-menu-button"
    type="button"
    aria-expanded={menu.open}
    aria-controls={listId}
    aria-label={label}
    data-moving={moving ? 'true' : undefined}
    bind:this={menu.button}
    onclick={menu.toggle}
  >
    <span class="org-menu-label">{t('organization')}</span>
    <b>{shownName}</b>
    {#if invited}<span class="chip">{invitationBadge}</span>{/if}
    {#if invited}<span class="org-menu-invite" aria-hidden="true"></span>{/if}
    <Icon name="chevron" />
  </button>
  <!-- 移っている最中を読み上げに伝える。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{moving ? t('organizationMoving') : ''}</span>
  <ul class="org-menu-list" id={listId} aria-label={t('organizationListLabel')} hidden={!menu.open}>
    {#each organizations as organization (organization.slug)}
      {@const current = organization.slug === currentSlug}
      <li>
        <a
          href={resolve('/[slug]', { slug: organization.slug })}
          aria-current={current ? 'page' : undefined}
          onclick={menu.close}
        >
          <span class="org-menu-name">{organizationLabel(organization)}</span>
          {#if current}<Icon name="check" />{/if}
        </a>
      </li>
    {/each}
    <li class="is-aside">
      <a href={resolve('/')} onclick={menu.close}>
        <span class="org-menu-name">{t('organizationList')}</span>
        {#if invited}<span class="org-menu-note">{t('invitationsReceived')}</span>{/if}
      </a>
    </li>
    <li class="is-aside">
      <button type="button" onclick={create}>
        <span class="org-menu-name">{t('createMyOrganizationAction')}</span>
      </button>
    </li>
    {#if canCreatePersonal}
      <li class="is-aside">
        <button type="button" onclick={createPersonal}>
          <span class="org-menu-name">{t('createPersonalOrganizationAction')}</span>
        </button>
      </li>
    {/if}
  </ul>
</div>
