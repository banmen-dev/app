<script lang="ts">
  import { afterNavigate, invalidateAll } from '$app/navigation';
  import { tick } from 'svelte';
  import { focusIsFree } from '../../../lib/focus-heading.ts';
  import { resolve } from '$app/paths';
  import Gate from '../../../lib/components/Gate.svelte';
  import GateSheet from '../../../lib/components/GateSheet.svelte';
  import LoadFailed from '../../../lib/components/LoadFailed.svelte';
  import LogoutButton from '../../../lib/components/LogoutButton.svelte';
  import ConfirmDialog from '../../../lib/components/ConfirmDialog.svelte';
  import Icon from '../../../lib/components/Icon.svelte';
  import BillingSummary from '../../../lib/components/BillingSummary.svelte';
  import { billingStateKeys, planName } from '../../../lib/plan-terms.ts';
  import { callOperation, type ApiResult } from '../../../lib/api.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import { formatDateTime } from '../../../lib/format-datetime.ts';
  import {
    billingAdminInvite,
    billingAdminRemove,
    billingInvitationRespond,
    operatorBillingAdminInvite,
  } from '../../../shared/operations/billing.ts';
  import type { DictionaryKey } from '../../../shared/vocabulary.ts';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let accountId = $state('');
  let bootstrapSlug = $state('');
  let bootstrapAccount = $state('');
  let busy = $state(false);
  let message = $state<DictionaryKey | null>(null);
  let failed = $state(false);
  let actionArea = $state('');
  let removeName = $state('');
  let confirmRemove: ReturnType<typeof ConfirmDialog>;
  let navigationVersion = 0;
  afterNavigate(({ from, to }) => {
    if (!from?.url || !to?.url || from.url.href === to.url.href) return;
    navigationVersion++;
    message = null;
    failed = false;
    actionArea = '';
    retryFailed = false;
    accountId = '';
    bootstrapSlug = '';
    bootstrapAccount = '';
  });
  // 自分用の組織は名前の代わりに辞書の「自分用」で出す（docs/data-model.md の organizations の kind）
  const organizationName = (organization: { kind: 'team' | 'personal'; name: string }) =>
    organization.kind === 'personal' ? t('personalOrganizationName') : organization.name;
  const personLabel = (name: string, id: string) => (name === id ? id : `${name}（${id}）`);
  const eventKeys = {
    invited: 'billingEventInvited',
    accepted: 'billingEventAccepted',
    declined: 'billingEventDeclined',
    removed: 'billingEventRemoved',
  } as const;
  // 契約と使用量の読み直し（「もう一度試す」）。押している間は止め、結果を状態の領域で伝え、成功したら読み直した紙の中身へフォーカスを移す（押したボタンは消える）
  let retrying = $state(false);
  let retryFailed = $state(false);
  // 契約と使用量を読めたら、前の読み直しの失敗を消す（担当者の保存で読み直したときを含む）
  $effect(() => {
    if (data.selected?.summary) retryFailed = false;
  });
  async function retrySummary() {
    if (retrying) return;
    const version = navigationVersion;
    retrying = true;
    retryFailed = false;
    try {
      await invalidateAll();
    } catch {
      // 読み直しそのものの失敗も、契約と使用量を読めなかったときと同じに扱う
    } finally {
      retrying = false;
    }
    if (version !== navigationVersion) return;
    if (data.failed || data.selected?.summary === null) {
      retryFailed = true;
      return;
    }
    await tick();
    // 読み直しの間に利用者が別の欄へ移っていれば、フォーカスを奪わない（save() と同じ）
    // 押したボタンは消えるので、フォーカスが行き場を失っているときだけ紙の中身へ移す
    if (focusIsFree()) document.getElementById('billing-summary-body')?.focus();
  }

  async function save(action: () => Promise<ApiResult<unknown>>, area: string, restoreFocus = false) {
    if (busy) return;
    const version = navigationVersion;
    const trigger = document.activeElement;
    const submitted = { accountId, bootstrapSlug, bootstrapAccount };
    busy = true;
    actionArea = area;
    message = null;
    // 担当者の保存で契約と使用量も読み直すので、前の読み直しの失敗の文は消しておく
    retryFailed = false;
    let restore = false;
    try {
      const result = await action();
      if (version !== navigationVersion) {
        if (result.ok) await invalidateAll();
        return;
      }
      failed = !result.ok;
      if (!result.ok) {
        message = result.error?.code === 'rate_limited' ? 'billingRateLimited' : 'billingFailed';
        restore = restoreFocus;
        return;
      }
      message = 'billingSaved';
      if (area === 'invite' && accountId === submitted.accountId) accountId = '';
      if (
        area === 'bootstrap' &&
        bootstrapSlug === submitted.bootstrapSlug &&
        bootstrapAccount === submitted.bootstrapAccount
      ) {
        bootstrapSlug = '';
        bootstrapAccount = '';
      }
      try {
        await invalidateAll();
        if (version !== navigationVersion) return;
        if (data.failed) {
          failed = true;
          message = 'billingRefreshFailed';
        } else restore = restoreFocus;
      } catch {
        if (version === navigationVersion) {
          failed = true;
          message = 'billingRefreshFailed';
        }
      }
    } finally {
      busy = false;
      if (restore && version === navigationVersion) {
        await tick();
        if (focusIsFree() || document.activeElement === trigger)
          document.getElementById(`billing-status-${area}`)?.focus();
      }
    }
  }

  async function remove(slug: string, id: string, name: string, trigger: HTMLElement) {
    if (busy) return;
    removeName = name;
    if (await confirmRemove.ask(trigger))
      await save(() => callOperation(billingAdminRemove, { slug, administrator_id: id }), 'administrators', true);
  }
</script>

{#snippet operationStatus(area: string)}
  <p id={`billing-status-${area}`} class:field-error={failed && actionArea === area} role="status" tabindex="-1">
    {actionArea === area ? (busy ? t('billingBusy') : message ? t(message) : '') : ''}
  </p>
{/snippet}

<svelte:head><title>{t('pageTitle', { page: t('billingTitle'), app: t('appName') })}</title></svelte:head>

{#if data.failed}
  <LoadFailed
    >{#snippet extra()}{#if message === 'billingSaved' || message === 'billingRefreshFailed'}<p
          class="field-error"
          role="alert"
        >
          {t('billingRefreshFailed')}
        </p>{/if}{/snippet}</LoadFailed
  >
{:else}
  <Gate>
    <GateSheet brand title={t('billingTitle')}>
      <p>{t('billingLead')}</p>
      <label class="field"
        ><span class="field-label">{t('billingAccountId')}</span><input
          class="input"
          readonly
          value={data.account_id}
        /></label
      >
      <p class="field-hint">{t('billingAccountHint')}</p>
      <div class="form-actions">
        <a class="btn is-sm" href={resolve('/')}>{t('organizationList')}</a><LogoutButton />
      </div>
    </GateSheet>
    {#if data.selected}
      {@const selected = data.selected}
      <GateSheet title={t('billingSummary', { name: organizationName(selected) })}>
        {#if selected.summary === null}
          <p class="field-error" role="alert">
            {t(selected.summaryRateLimited ? 'billingRateLimited' : 'billingSummaryLoadFailed')}
          </p>
          <div class="form-actions">
            <button class="btn is-sm" type="button" aria-disabled={retrying} onclick={retrySummary}>{t('retry')}</button
            >
          </div>
          <p id="billing-status-summary" class:field-error={retryFailed} role="status">
            {retrying ? t('billingSummaryRetrying') : retryFailed ? t('billingSummaryRetryFailed') : ''}
          </p>
        {:else}<BillingSummary summary={selected.summary} />{/if}
      </GateSheet>
      <GateSheet title={t('billingAdministrators', { name: organizationName(selected) })}>
        <div class="form-actions"><a class="btn" href={resolve('/auth/billing')}>{t('billingBack')}</a></div>
        <p class="field-hint">{t('billingLastHint')}</p>
        <p class="field-hint">{t('billingNominationHint')}</p>
        <div class="choice-list">
          {#each selected.administrators as person (person.id)}
            <div class="choice is-static">
              <div>
                <b>{person.name}</b><span>{person.status === 'active' ? t('billingActive') : t('billingPending')}</span
                ><span class="field-hint">{person.account_id}</span>
              </div>
              <div class="form-actions">
                <button
                  class="btn"
                  type="button"
                  aria-disabled={busy}
                  aria-label={t('billingRemoveFor', { name: personLabel(person.name, person.account_id) })}
                  onclick={(event) => remove(selected.slug, person.id, person.name, event.currentTarget)}
                  >{t('billingRemove')}</button
                >
              </div>
            </div>
          {/each}
        </div>
        {@render operationStatus('administrators')}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void save(
              () => callOperation(billingAdminInvite, { slug: selected.slug, account_id: accountId.trim() }),
              'invite',
            );
          }}
        >
          <label class="field"
            ><span class="field-label">{t('billingTargetAccount')}</span><input
              class="input"
              bind:value={accountId}
              aria-describedby="billing-status-invite"
              aria-invalid={failed && actionArea === 'invite'}
              required
              maxlength="36"
            /></label
          >
          <div class="form-actions">
            <button class="btn is-primary" type="submit" disabled={busy}>{t('billingInvite')}</button>
          </div>
          {@render operationStatus('invite')}
        </form>
      </GateSheet>
      <GateSheet title={t('billingHistory')}>
        {#if selected.events.length === 0}<p>{t('billingHistoryEmpty')}</p>{/if}
        {#each selected.events as entry (entry.id)}
          <div class="choice is-static">
            <div>
              <b>{t(eventKeys[entry.action])}</b><span class="mono">{formatDateTime(entry.created_at)}</span><span
                >{t('billingTarget')}: {entry.target_name ?? entry.target_account_id}</span
              ><span>{t('billingActor')}: {entry.actor_name ?? entry.actor_account_id}</span>
            </div>
          </div>
        {/each}
      </GateSheet>
    {:else}
      <GateSheet title={t('billingInvitations')}>
        {#if data.invitations.length === 0}<p>{t('billingInvitationEmpty')}</p>{/if}
        {#each data.invitations as invitation (invitation.id)}
          <div class="choice is-static">
            <div>
              <b>{invitation.name}</b>
            </div>
            <div class="form-actions">
              <button
                class="btn is-primary"
                type="button"
                aria-disabled={busy}
                aria-label={t('billingAcceptFor', { name: `${invitation.name}（${invitation.slug}）` })}
                onclick={() =>
                  save(
                    () => callOperation(billingInvitationRespond, { invitation_id: invitation.id, accept: true }),
                    'invitations',
                    true,
                  )}>{t('billingAccept')}</button
              ><button
                class="btn"
                type="button"
                aria-disabled={busy}
                aria-label={t('billingDeclineFor', { name: `${invitation.name}（${invitation.slug}）` })}
                onclick={() =>
                  save(
                    () => callOperation(billingInvitationRespond, { invitation_id: invitation.id, accept: false }),
                    'invitations',
                    true,
                  )}>{t('billingDecline')}</button
              >
            </div>
          </div>
        {/each}
        {@render operationStatus('invitations')}
      </GateSheet>
      <GateSheet title={t('billingOrganizations')}>
        {#if data.organizations.length === 0}<p>{t('billingEmpty')}</p>{/if}
        <div class="choice-list">
          {#each data.organizations as organization (organization.slug)}<a
              class="choice"
              data-sveltekit-preload-data="off"
              href={resolve(`/auth/billing?organization=${encodeURIComponent(organization.slug)}`)}
              ><div>
                <b>{organizationName(organization)}</b>
                <!-- 自分用の組織はどれも「自分用」なので、ほかの人の自分用を複数担当しても見分けられるよう slug を添える -->
                {#if organization.kind === 'personal'}<span class="mono">{organization.slug}</span>{/if}
                <div class="entry-meta">
                  <span class="chip">{planName(organization, t)}</span>
                  <span class="chip" class:is-warn={organization.state !== 'active'}
                    >{t(billingStateKeys[organization.state])}</span
                  >
                </div>
              </div>
              <Icon name="chevron" /></a
            >{/each}
        </div>
      </GateSheet>
      {#if data.operator}
        <GateSheet title={t('billingBootstrap')}>
          <p>{t('billingBootstrapHint')}</p>
          <form
            onsubmit={(event) => {
              event.preventDefault();
              void save(
                () =>
                  callOperation(operatorBillingAdminInvite, {
                    slug: bootstrapSlug.trim(),
                    account_id: bootstrapAccount.trim(),
                  }),
                'bootstrap',
              );
            }}
          >
            <label class="field"
              ><span class="field-label">{t('billingSlug')}</span><input
                class="input"
                bind:value={bootstrapSlug}
                aria-describedby="billing-status-bootstrap"
                aria-invalid={failed && actionArea === 'bootstrap'}
                required
                maxlength="63"
              /></label
            >
            <label class="field"
              ><span class="field-label">{t('billingTargetAccount')}</span><input
                class="input"
                bind:value={bootstrapAccount}
                aria-describedby="billing-status-bootstrap"
                aria-invalid={failed && actionArea === 'bootstrap'}
                required
                maxlength="36"
              /></label
            >
            <div class="form-actions">
              <button class="btn is-primary" type="submit" disabled={busy}>{t('billingInvite')}</button>
            </div>
            {@render operationStatus('bootstrap')}
          </form>
        </GateSheet>
      {/if}
    {/if}
  </Gate>
{/if}

<ConfirmDialog
  bind:this={confirmRemove}
  title={t('billingRemoveTitle')}
  confirmLabel={t('billingRemove')}
  cancelLabel={t('cancel')}
  danger><p>{t('billingRemoveText', { name: removeName })}</p></ConfirmDialog
>
