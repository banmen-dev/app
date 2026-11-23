<script lang="ts">
  import { tick } from 'svelte';
  import { afterNavigate, beforeNavigate, goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import ConfirmDialog from '../../../../../lib/components/ConfirmDialog.svelte';
  import ColumnsSetting from '../../../../../lib/components/ColumnsSetting.svelte';
  import DefinitionsSetting from '../../../../../lib/components/DefinitionsSetting.svelte';
  import SprintNamingSetting from '../../../../../lib/components/SprintNamingSetting.svelte';
  import DodSetting from '../../../../../lib/components/DodSetting.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import Setting from '../../../../../lib/components/Setting.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import WorkspaceDeleteSetting from '../../../../../lib/components/WorkspaceDeleteSetting.svelte';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // ワークスペースの設定の画面（design/settings.html）。今あるのは列（ColumnsSetting）、決まった欄（DefinitionsSetting の kind = 'field'）、
  // 命名ルール（SprintNamingSetting）、完成の定義（DodSetting）、区分とリポジトリの節で、
  // ほかの節（一般、換算比率、ワークスペースの休日）は、それぞれの Issue で .settings の中に、見本の順に足す。
  // 完成の定義は枠の値（workspace.definitionOfDone）を出し、保存したら枠（app:workspace）を読み直す。
  // 開けるのはリーダーと管理者だけ。一般のメンバーが URL で開いたら「入れない」の案内と、バックログへ戻るリンクを出す（メニューにも出さない）。
  // 閉じたワークスペースでは、節を読み取り専用で出す（枠が読み取り専用の帯を出す）。
  // 一覧の初回失敗は画面全体を LoadFailed にし、命名ルールの失敗はその節だけへ出す。書いた後の読み直しが失敗したときは、前に読めた一覧を残したまま、
  // 節の先頭に「一覧を更新できませんでした」と「もう一度試す」を出す（組織の管理の画面の SectionBoundary と同じ扱い）
  let { data }: PageProps = $props();

  type Definitions = NonNullable<typeof data.definitions>;

  const workspace = $derived(data.workspace);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);

  // 前に読めた一覧と、読み直しに失敗したか。ワークスペースが替わったら捨てる
  let kept = $state<{ workspaceId: string; definitions: Definitions } | null>(null);
  let refreshFailed = $state(false);
  let retrying = $state(false);
  let retryFailed = $state(false);
  $effect.pre(() => {
    const id = workspace?.id ?? null;
    if (data.definitions !== null && id !== null) {
      kept = { workspaceId: id, definitions: data.definitions };
      refreshFailed = false;
    } else if (kept !== null && kept.workspaceId !== id) {
      kept = null;
    }
  });
  const definitions = $derived(
    data.definitions ?? (kept !== null && kept.workspaceId === workspace?.id ? kept.definitions : null),
  );

  let keptNaming = $state.raw<{ workspaceId: string; value: NonNullable<typeof data.naming> } | null>(null);
  $effect.pre(() => {
    const id = workspace?.id ?? null;
    if (data.naming !== null && id !== null) keptNaming = { workspaceId: id, value: data.naming };
    else if (keptNaming?.workspaceId !== id) keptNaming = null;
  });
  const naming = $derived(
    data.naming ?? (keptNaming?.workspaceId === workspace?.id ? (keptNaming?.value ?? null) : null),
  );

  async function reload(): Promise<void> {
    await invalidate('app:workspace-settings');
    refreshFailed = data.definitions === null && kept !== null;
  }

  // 「もう一度試す」で読み直せたら、押したボタンが囲みごと消えるので、先頭の節の見出しへフォーカスを移し、
  // 常に置いた読み上げの領域で伝える（囲みの中の status は一緒に消えて読まれないため）
  let refreshedMessage = $state('');
  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    retryFailed = false;
    refreshedMessage = '';
    try {
      await reload();
      retryFailed = refreshFailed || data.naming === null;
    } finally {
      retrying = false;
    }
    if (retryFailed) return;
    refreshedMessage = t('settingsRefreshed');
    await tick();
    const heading = document.querySelector<HTMLElement>('.settings .setting-title');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus();
  }

  let namingDirty = $state(false);
  let dodDirty = $state(false);
  let dirtyWorkspaceId: string | null = null;
  $effect.pre(() => {
    const id = workspace?.id ?? null;
    if (dirtyWorkspaceId === id && !data.forbidden) return;
    dirtyWorkspaceId = id;
    namingDirty = false;
    dodDirty = false;
  });
  // ---- 書きかけのまま移るときの確かめ（TaskDrawer と同じ扱い） ----
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let asking = false;
  let leaving = false;
  afterNavigate(() => {
    leaving = false;
  });
  beforeNavigate((navigation) => {
    if (leaving || !canWrite || !(namingDirty || dodDirty)) return;
    if (navigation.to === null) {
      navigation.cancel();
      return;
    }
    const to = navigation.to.url;
    if (to.origin === location.origin && to.pathname === location.pathname) return;
    const delta = navigation.type === 'popstate' ? navigation.delta : undefined;
    navigation.cancel();
    if (asking) return;
    asking = true;
    void (discardDialog?.ask() ?? Promise.resolve(false))
      .then((discard) => {
        if (!discard) return;
        leaving = true;
        if (to.origin !== location.origin) location.href = to.href;
        else if (delta !== undefined && delta !== 0) history.go(delta);
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- 行き先は SvelteKit が解決した URL（navigation.to）で、経路から作り直せない
        else void goto(to);
      })
      .finally(() => {
        asking = false;
      });
  });

  function stale(): void {
    void invalidate('app:workspace');
  }
</script>

<svelte:head>
  {#if workspace}
    <title>
      {t('pageTitle', {
        page: t('settingsPageName', { settings: t('pageSettings'), name: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#if workspace && data.forbidden}
  <PageHead title={t('pageSettings')} eyebrow={workspace.name} />
  <EmptyState
    icon="lock"
    title={t('settingsForbiddenTitle')}
    text={t('settingsForbiddenText', { settings: t('pageSettings'), leader: t('leader'), admin: t('admin') })}
  >
    {#snippet actions()}
      <a class="btn is-sm" href={resolve('/[slug]/w/[id]', { slug, id: workspace.id })}
        >{t('settingsBackToBacklog', { backlog: t('backlog') })}</a
      >
    {/snippet}
  </EmptyState>
{:else if workspace && definitions === null}
  <LoadFailed inShell />
{:else if workspace && definitions !== null}
  <PageHead title={t('pageSettings')} eyebrow={workspace.name} />
  <p class="visually-hidden" role="status">{refreshedMessage}</p>
  {#if refreshFailed}
    <div class="callout is-warn">
      <Icon name="alert" /><span role="alert">{t('settingsRefreshFailed')}</span>
      <div class="callout-actions">
        <button class="btn is-sm" type="button" aria-disabled={retrying} onclick={() => void retry()}
          >{t('retry')}</button
        >
        <span class="field-hint" role="status">{retrying ? t('retrying') : retryFailed ? t('retryFailed') : ''}</span>
      </div>
    </div>
  {/if}
  <div class="settings">
    {#key workspace.id}
      <ColumnsSetting
        {slug}
        workspaceId={workspace.id}
        columns={definitions.columns}
        {canWrite}
        onchanged={reload}
        onstale={stale}
      />
      <DefinitionsSetting
        kind="field"
        {slug}
        workspaceId={workspace.id}
        items={definitions.fields}
        {canWrite}
        onchanged={reload}
        onstale={stale}
      />
      {#if naming === null}
        <Setting
          title={t('sprintNamingTitle', { sprint: t('sprint') })}
          description={t('sprintNamingDesc', { sprint: t('sprint') })}
        >
          <p class="field-error" role="alert"><Icon name="alert" />{t('sprintNamingLoadFailed')}</p>
          <button class="btn is-sm" type="button" aria-disabled={retrying} onclick={() => void retry()}
            >{t('retry')}</button
          >
          <span class="field-hint" role="status">{retrying ? t('retrying') : retryFailed ? t('retryFailed') : ''}</span>
        </Setting>
      {:else}
        <SprintNamingSetting
          {slug}
          workspaceId={workspace.id}
          ondirty={(dirty) => (namingDirty = dirty)}
          value={naming}
          refreshFailed={data.naming === null}
          onretry={retry}
          {retrying}
          retryFailed={retryFailed && data.naming === null}
          {canWrite}
          onsaved={reload}
          onstale={stale}
        />
      {/if}
      <DodSetting
        {slug}
        workspaceId={workspace.id}
        ondirty={(dirty) => (dodDirty = dirty)}
        value={workspace.definitionOfDone}
        {canWrite}
        onsaved={() => invalidate('app:workspace')}
        onstale={stale}
      />
      <DefinitionsSetting
        kind="category"
        {slug}
        workspaceId={workspace.id}
        items={definitions.categories}
        {canWrite}
        onchanged={reload}
        onstale={stale}
      />
      <DefinitionsSetting
        kind="repository"
        {slug}
        workspaceId={workspace.id}
        items={definitions.repositories}
        {canWrite}
        onchanged={reload}
        onstale={stale}
      />
      {#if data.organization?.me.is_admin === true && data.workspaceDeleteEnabled}
        <WorkspaceDeleteSetting {slug} {workspace} />
      {/if}
    {/key}
  </div>
{/if}

<ConfirmDialog
  bind:this={discardDialog}
  title={t('discardTitle')}
  confirmLabel={t('discardConfirm')}
  cancelLabel={t('discardKeep')}
  danger
>
  <p>{t('discardText')}</p>
</ConfirmDialog>
