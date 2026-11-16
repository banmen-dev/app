<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import CreateMyOrganizationDialog from '../lib/components/CreateMyOrganizationDialog.svelte';
  import Gate from '../lib/components/Gate.svelte';
  import Pane from '../lib/components/Pane.svelte';
  import MyTodayPane from '../lib/components/MyTodayPane.svelte';
  import NewsPane from '../lib/components/NewsPane.svelte';
  import { latestNews } from '../lib/news.ts';
  import GateSheet from '../lib/components/GateSheet.svelte';
  import LoadFailed from '../lib/components/LoadFailed.svelte';
  import LogoutButton from '../lib/components/LogoutButton.svelte';
  import CreatePersonalOrganizationDialog from '../lib/components/CreatePersonalOrganizationDialog.svelte';
  import { hasPersonalOrganization, organizationLabel } from '../lib/organization-label.ts';
  import { t } from '../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 全組織のダッシュボード。本人の今日やることは閲覧のみ。
  const news = latestNews();
  let { data }: PageProps = $props();
  let createDialog = $state<ReturnType<typeof CreateMyOrganizationDialog>>();
  let createDialogOpen = $state(false);
  let personalDialog = $state<ReturnType<typeof CreatePersonalOrganizationDialog>>();
  let personalDialogOpen = $state(false);
  // 自分用は1アカウントに1つ。入れる組織にも停止した組織にも無いときだけ、作る入口を出す
  // （どちらの一覧にも出ない自分用を持つ人、たとえばその組織で無効にされた人には出し、
  // 押すとサーバーが 409 の personal_limit で断り、ダイアログが示す）。
  const canCreatePersonal = $derived(!data.failed && !hasPersonalOrganization([data.organizations, data.suspended]));
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
          <Pane id="p-organizations" title={t('organizationListLabel')}>
            {#if data.organizations.length > 0}
              <p>{t('organizationChooseLead', { count: data.organizations.length })}</p>
              <div class="choice-list">
                {#each data.organizations as organization (organization.slug)}
                  <a class="choice" href={resolve('/[slug]', { slug: organization.slug })}>
                    <div>
                      <b>{organizationLabel(organization)}</b>
                      <span class="mono">{page.url.host}/{organization.slug}/</span>
                    </div>
                    <Icon name="chevron" />
                  </a>
                {/each}
              </div>
              <p class="gate-note">{t('organizationChooseNote')}</p>
            {:else if data.invitations.length > 0}
              <p>{t('organizationChooseInvitedLead')}</p>
              <h3 class="dialog-title">{t('invitationsHeading')}</h3>
              {@render invitationList()}
              <p class="gate-note">{t('invitationsNote')}</p>
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
              <div class="form-actions">{@render createAction(false)}{@render createPersonalAction()}</div>
            {/if}
          </Pane>
          {#if data.invitations.length > 0 && data.organizations.length > 0}
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
        <div class="dashboard-side"><MyTodayPane today={data.today} /><NewsPane items={news} /></div>
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
