<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import CreateMyOrganizationDialog from '../lib/components/CreateMyOrganizationDialog.svelte';
  import Gate from '../lib/components/Gate.svelte';
  import Pane from '../lib/components/Pane.svelte';
  import MyTodayPane from '../lib/components/MyTodayPane.svelte';
  import NewsPane from '../lib/components/NewsPane.svelte';
  import RecentActivity from '../lib/components/RecentActivity.svelte';
  import WorkspaceCreateDialog from '../lib/components/WorkspaceCreateDialog.svelte';
  import { latestNews } from '../lib/news.ts';
  import GateSheet from '../lib/components/GateSheet.svelte';
  import LoadFailed from '../lib/components/LoadFailed.svelte';
  import FeedbackLauncher from '../lib/components/FeedbackLauncher.svelte';
  import LogoutButton from '../lib/components/LogoutButton.svelte';
  import CreatePersonalOrganizationDialog from '../lib/components/CreatePersonalOrganizationDialog.svelte';
  import { callOperation } from '../lib/api.ts';
  import { dashboardWorkspacesOf, type MyWorkspacesView } from '../lib/dashboard-workspaces.ts';
  import { hasPersonalOrganization, organizationLabel } from '../lib/organization-label.ts';
  import { t } from '../lib/vocabulary.svelte.ts';
  import { myWorkspaces } from '../shared/operations/organization/my-workspaces.ts';
  import type { PageProps } from './$types';

  // 全組織のダッシュボード。左の列に、自分用の面（自分用のワークスペースと、作る入口）、組織の面（組織ごとのまとまりに、所属するワークスペース）、
  // 全組織の今日やること、届いた招待、停止している組織。右の列に、全組織の最近の更新とニュース。今日やることと最近の更新は閲覧のみ。
  // ワークスペースは load で待たず、画面が置かれた後に my-workspaces で読む（組織の入口を先に出す。今日やることと同じ）
  const news = latestNews();
  let { data }: PageProps = $props();
  let createDialog = $state<ReturnType<typeof CreateMyOrganizationDialog>>();
  let createDialogOpen = $state(false);
  let personalDialog = $state<ReturnType<typeof CreatePersonalOrganizationDialog>>();
  let personalDialogOpen = $state(false);
  let workspaceDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();
  // 自分用は1アカウントに1つ。入れる組織にも停止した組織にも無いときだけ、作る入口を出す
  // （どちらの一覧にも出ない自分用を持つ人、たとえばその組織で無効にされた人には出し、
  // 押すとサーバーが 409 の personal_limit で断り、ダイアログが示す）。
  const canCreatePersonal = $derived(!data.failed && !hasPersonalOrganization([data.organizations, data.suspended]));
  const personalOrganization = $derived(
    data.failed ? undefined : data.organizations.find((organization) => organization.kind === 'personal'),
  );
  const teamOrganizations = $derived(
    data.failed ? [] : data.organizations.filter((organization) => organization.kind !== 'personal'),
  );
  // 自分用の面を出すか。自分用に入れるときと、チーム用の組織に入れて自分用を作れるとき。
  // どちらでもない人（入れる組織が無い人など）は、組織の面の空の案内に「自分用を作る」を並べる
  const showPersonalPane = $derived(
    personalOrganization !== undefined || (teamOrganizations.length > 0 && canCreatePersonal),
  );

  // 組織ごとのワークスペース。最後に読めた答えを持ち、読み直しが失敗しても消さない（workspacesError で失敗だけを知らせる）。
  // 一度も読めずに失敗したときだけ、行の位置に何も出さない（面の先頭の警告と「もう一度試す」だけにする）
  let workspaces = $state<MyWorkspacesView>();
  let workspacesError = $state(false);
  const workspacesView = $derived(workspaces ?? (workspacesError ? null : undefined));
  let workspacesGeneration = 0;
  let workspacesRetrying = $state(false);
  // 読んでいる間（最初の読み込みと読み直しの両方）
  let workspacesLoading = $state(false);
  // 自分用での自分のユーザーの ID（ワークスペースを作るダイアログの、最初のリーダーの既定）。一度読めたら持ち続け、
  // 作った後の読み直しが失敗しても、開いているダイアログ（完了の表示）を外さない
  let personalMeId = $state<string>();
  async function loadWorkspaces(): Promise<void> {
    const token = ++workspacesGeneration;
    workspacesLoading = true;
    const result = await callOperation(myWorkspaces, {});
    if (token !== workspacesGeneration) return;
    workspacesLoading = false;
    if (!result.ok) {
      workspacesError = true;
      return;
    }
    workspaces = result.data;
    workspacesError = false;
    const personal = result.data.organizations.find((entry) => entry.organization.kind === 'personal');
    if (personal !== undefined) personalMeId = personal.me_id;
  }
  // 入れる組織の並び（slug）が変わったときに読む。最初の表示、組織を読めなかった画面からの「もう一度試す」、
  // 組織を作った後の読み直し（invalidateAll）で組織が増えたときに当たる。並びが同じ読み直しでは読まない
  const organizationKey = $derived(
    data.failed ? '' : data.organizations.map((organization) => organization.slug).join(' '),
  );
  $effect(() => {
    if (organizationKey === '') return;
    untrack(() => void loadWorkspaces());
  });
  onMount(() => () => {
    workspacesGeneration++;
  });
  async function retryWorkspaces(): Promise<void> {
    if (workspacesRetrying) return;
    workspacesRetrying = true;
    try {
      await loadWorkspaces();
    } finally {
      workspacesRetrying = false;
    }
    // 読めたら押したボタンが消えるので、フォーカスがボタンか body に残っていれば、面の見出しへ移す
    if (!workspacesError) {
      await tick();
      if (document.activeElement === document.body || document.activeElement === null) {
        document.getElementById(personalOrganization !== undefined ? 'p-personal' : 'p-organizations')?.focus();
      }
    }
  }
  const personalWorkspaces = $derived(
    personalOrganization === undefined
      ? undefined
      : dashboardWorkspacesOf(workspacesView, personalOrganization.slug, workspacesLoading),
  );
</script>

<!-- 自分の組織を作る入口。入れる組織が無く、ほかに進む道が無い人だけ主ボタンにし、ほかは一覧や案内の下の静かな大きさにそろえる -->
{#snippet createAction(primary: boolean)}
  <button
    class="btn"
    class:is-primary={primary}
    class:is-sm={!primary}
    type="button"
    onclick={(event) => createDialog?.show(event.currentTarget)}>{t('createMyOrganizationAction')}</button
  >
{/snippet}

<!-- 自分用の組織を作る入口。主ボタンにはせず、「組織を作る」と同じ静かな大きさで隣に並べる。自分用を持つ人には出さない -->
{#snippet createPersonalAction()}
  {#if canCreatePersonal}
    <button class="btn is-sm" type="button" onclick={(event) => personalDialog?.show(event.currentTarget)}
      >{t('createPersonalOrganizationAction')}</button
    >
  {/if}
{/snippet}

<!-- 届いた招待の行。組織ごとに1件で、押すとその組織の招待の画面へ移る -->
{#snippet invitationList()}
  <div class="choice-list">
    {#each data.invitations as invitation (invitation.slug)}
      <a class="choice" href={resolve('/[slug]/invitations', { slug: invitation.slug })}>
        <div>
          <b>{invitation.organization_name}</b>
          <span>{t('invitationPending')}</span>
        </div>
        <Icon name="chevron" />
      </a>
    {/each}
  </div>
{/snippet}

<!-- ワークスペースの読み込みの状態。常に置いた role="status" の文字だけを替えて読み込み中を伝え、全体が読めなかったときは
     案内と「もう一度試す」を出す。自分用の面（自分用に入れる人）か組織の面の、先に出る1か所にだけ置く -->
{#snippet workspacesStatus()}
  <!-- 最初の読み込みは面の aria-busy と骨組みで伝え、文は空から始める（マウント時に文字を持った領域は読み上げられない恐れがあるため。
       RecentActivity と同じ）。文を出すのは、前の答えを持ったままの読み直しの間だけ -->
  <span class="visually-hidden" role="status">{workspacesLoading && workspaces !== undefined ? t('loading') : ''}</span>
  {#if workspacesError}
    <div class="callout is-warn">
      <Icon name="alert" /><span role="alert"
        >{t(workspaces === undefined ? 'dashboardWorkspacesLoadFailed' : 'dashboardWorkspacesRefreshFailed', {
          workspace: t('workspace'),
        })}</span
      >
    </div>
    <div class="form-actions">
      <button class="btn is-sm" type="button" aria-disabled={workspacesRetrying} onclick={() => void retryWorkspaces()}
        >{t('retry')}</button
      >
      <span class="field-hint" role="status">{workspacesRetrying ? t('retrying') : ''}</span>
    </div>
  {/if}
{/snippet}

<!-- 1つの組織の、所属するワークスペースの行（組織の行の罫の下 .org-block-body）。押すとそのワークスペースのバックログへ移る。
     読んでいる間は骨組み、読めないときは短い案内。全体が読めなかったときは、罫ごと置かない（案内は面の先頭の1か所だけ） -->
{#snippet workspaceRows(organization: { slug: string; name: string; kind: 'team' | 'personal' })}
  {@const slug = organization.slug}
  {@const state = dashboardWorkspacesOf(workspacesView, slug, workspacesLoading)}
  {#if state.kind !== 'unavailable'}
    <div class="org-block-body">
      {#if state.kind === 'loading'}
        <div class="skeleton" aria-hidden="true"><span class="skeleton-line is-block"></span></div>
      {:else if state.kind === 'failed'}
        <p class="workspace-note">{t('dashboardWorkspacesFailedOrganization', { workspace: t('workspace') })}</p>
      {:else if state.kind === 'omitted'}
        <p class="workspace-note">{t('dashboardWorkspacesOmitted', { workspace: t('workspace') })}</p>
      {:else if state.entry.workspaces.length === 0}
        <p class="workspace-note">{t('dashboardNoWorkspace', { workspace: t('workspace') })}</p>
      {:else}
        <ul
          class="pane-list"
          aria-label={t('dashboardWorkspaceListLabel', {
            organization: organizationLabel(organization),
            workspace: t('workspace'),
          })}
        >
          {#each state.entry.workspaces as workspace (workspace.id)}
            <li>
              <a class="pane-link" href={resolve('/[slug]/w/[id]', { slug, id: workspace.id })}>
                <b>{workspace.name}</b>
                <span class="pane-link-role">{t(workspace.role)}</span>
                <Icon name="chevron" />
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:head>
  <title>{t('pageTitle', { page: t('organizationList'), app: t('appName') })}</title>
</svelte:head>

{#if data.failed}
  <LoadFailed />
{:else}
  <Gate wide>
    <GateSheet brand title={t('organizationList')}>
      <div class="dashboard">
        <div class="dashboard-main">
          {#if showPersonalPane}
            <Pane id="p-personal" title={t('personalOrganizationName')} busy={personalWorkspaces?.kind === 'loading'}>
              {#if personalOrganization !== undefined}
                {@render workspacesStatus()}
                <div class="org-block">
                  <a
                    class="choice"
                    href={resolve('/[slug]', { slug: personalOrganization.slug })}
                    aria-label={t('dashboardPersonalHomeLabel', {
                      personal: t('personalOrganizationName'),
                      address: `${page.url.host}/${personalOrganization.slug}/`,
                    })}
                  >
                    <div>
                      <b>{t('dashboardPersonalHome')}</b>
                      <span class="mono">{page.url.host}/{personalOrganization.slug}/</span>
                    </div>
                    <Icon name="chevron" />
                  </a>
                  {@render workspaceRows(personalOrganization)}
                </div>
                {#if personalWorkspaces?.kind === 'ready'}
                  <div class="form-actions">
                    <button
                      class="btn is-sm"
                      type="button"
                      onclick={(event) => workspaceDialog?.show(event.currentTarget)}
                      ><Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}</button
                    >
                  </div>
                {/if}
              {:else}
                <p>
                  {t('dashboardPersonalMissing', {
                    workspace: t('workspace'),
                    personal: t('personalOrganizationName'),
                  })}
                </p>
                <div class="form-actions">{@render createPersonalAction()}</div>
              {/if}
            </Pane>
          {/if}
          <Pane
            id="p-organizations"
            title={t('paneOrganizations')}
            busy={teamOrganizations.length > 0 && workspacesView === undefined}
          >
            {#if teamOrganizations.length > 0}
              {#if personalOrganization === undefined}{@render workspacesStatus()}{/if}
              <div class="org-blocks">
                {#each teamOrganizations as organization (organization.slug)}
                  <div class="org-block">
                    <a class="choice" href={resolve('/[slug]', { slug: organization.slug })}>
                      <div>
                        <b>{organizationLabel(organization)}</b>
                        <span class="mono">{page.url.host}/{organization.slug}/</span>
                      </div>
                      <Icon name="chevron" />
                    </a>
                    {@render workspaceRows(organization)}
                  </div>
                {/each}
              </div>
              <p class="gate-note">{t('organizationChooseNote')}</p>
            {:else if data.invitations.length > 0}
              <p>{t('organizationChooseInvitedLead')}</p>
              <h3 class="dialog-title">{t('invitationsHeading')}</h3>
              {@render invitationList()}
              <p class="gate-note">{t('invitationsNote')}</p>
            {:else if personalOrganization !== undefined}
              <p>{t('dashboardNoTeamOrganization', { organization: t('organization') })}</p>
            {:else if data.suspended.length > 0}
              <EmptyState
                icon="shield"
                title={t('noOrganizationTitle')}
                text={t('noOrganizationSuspendedText', { organization: t('organization') })}
              >
                {#snippet actions()}{@render createAction(false)}{@render createPersonalAction()}{/snippet}
              </EmptyState>
            {:else}
              <EmptyState
                icon="shield"
                title={t('noOrganizationTitle')}
                text={t('noOrganizationText', {
                  organization: t('organization'),
                  personal: t('personalOrganizationName'),
                })}
              >
                {#snippet actions()}{@render createAction(true)}{@render createPersonalAction()}{/snippet}
              </EmptyState>
            {/if}
            {#if data.organizations.length > 0 || data.invitations.length > 0}
              <div class="form-actions">
                {@render createAction(false)}{#if !showPersonalPane}{@render createPersonalAction()}{/if}
              </div>
            {/if}
          </Pane>
          {#if data.organizations.length > 0}<MyTodayPane />{/if}
          {#if data.invitations.length > 0 && teamOrganizations.length > 0}
            <Pane id="p-invitations" title={t('invitationsHeading')}>
              {@render invitationList()}
              <p class="gate-note">{t('invitationsNote')}</p>
            </Pane>
          {/if}
          {#if data.suspended.length > 0}
            <Pane id="p-suspended" title={t('suspendedOrganizationsHeading', { organization: t('organization') })}>
              <div class="choice-list">
                {#each data.suspended as organization (organization.slug)}
                  <div class="choice is-static">
                    <div>
                      <b>{organizationLabel(organization)}</b>
                      <span>{t('suspendedOrganizationStatus')}</span>
                    </div>
                  </div>
                {/each}
              </div>
              <p class="gate-note">{t('suspendedOrganizationsNote', { organization: t('organization') })}</p>
            </Pane>
          {/if}
        </div>
        <div class="dashboard-side">
          {#if data.organizations.length > 0}<RecentActivity />{/if}
          <NewsPane items={news} />
        </div>
      </div>
      <div class="form-actions">
        {#if data.operator}
          <a class="btn is-sm" href={resolve('/operator')}>{t('operatorOpen')}</a>
        {/if}
        <a class="btn is-sm" href={resolve('/auth/billing')}>{t('billingOpen')}</a>
        <LogoutButton />
      </div>
    </GateSheet>
  </Gate>
{/if}

<CreateMyOrganizationDialog bind:this={createDialog} bind:open={createDialogOpen} />
<CreatePersonalOrganizationDialog bind:this={personalDialog} bind:open={personalDialogOpen} />
{#if personalOrganization !== undefined && personalMeId !== undefined}
  <WorkspaceCreateDialog
    bind:this={workspaceDialog}
    slug={personalOrganization.slug}
    meId={personalMeId}
    oncreated={() => void loadWorkspaces()}
  />
{/if}
<!-- ログインした人だけがここまで来る（401 は load がログインへ移す） -->
<FeedbackLauncher />
