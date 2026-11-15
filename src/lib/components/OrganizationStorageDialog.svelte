<script lang="ts">
  import type { z } from 'zod';
  import { invalidateAll } from '$app/navigation';
  import { organizationStorageUpdate, type organizationContract } from '../../shared/operations/operator/index.ts';
  import { billingIntervals, contractLimits, type BillingInterval } from '../../shared/organization-plan.ts';
  import { callOperation } from '../api.ts';
  import { needsCustomContractLimits } from '../plan-terms.ts';
  import { quotaSize } from '../format.ts';
  import { isUnauthenticated } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  type Outcome = 'done' | 'state_changed' | 'purge_due' | 'unavailable' | 'unauthenticated';
  type Target = {
    slug: string;
    name: string;
    kind: 'team' | 'personal';
    contract: z.infer<typeof organizationContract> | null;
    attachment_quota_bytes: number;
    attachment_used_bytes: number;
    suspended_at: string | null;
  };
  let { onfinish }: { onfinish: (outcome: Outcome) => void } = $props();
  let dialog = $state<ReturnType<typeof Dialog>>();
  let open = $state(false);
  let target = $state<Target | null>(null);
  let units10 = $state<number | undefined>(0);
  let units50 = $state<number | undefined>(0);
  let interval = $state<BillingInterval>('monthly');
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let errors = $state<{ units10?: string; units50?: string }>({});
  let reloadOnClose = false;
  let generation = 0;
  const ids = $props.id();
  const valid = $derived([units10, units50].every((n) => n !== undefined && Number.isInteger(n) && n >= 0 && n <= 100));
  const unchanged = $derived(
    target?.contract !== null &&
      target?.contract !== undefined &&
      target.contract.extra_10gb_units === units10 &&
      target.contract.extra_50gb_units === units50 &&
      target.contract.billing_interval === interval,
  );
  const next = $derived(
    contractLimits({
      plan: target?.contract?.plan ?? 'personal',
      custom_member_limit: target?.contract?.custom_member_limit ?? null,
      custom_attachment_quota_bytes: target?.contract?.custom_attachment_quota_bytes ?? null,
      extra_10gb_units: units10 ?? 0,
      extra_50gb_units: units50 ?? 0,
    }),
  );
  const intervalNames = $derived({ monthly: t('billingMonthly'), yearly: t('billingYearly') });
  function sizeText(bytes: number): string {
    const size = quotaSize(bytes);
    return t(size.unit === 'gb' ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', { size: size.size });
  }
  export function show(row: Target, trigger?: HTMLElement | null): void {
    if (needsCustomContractLimits(row.contract) || (row.kind === 'personal' && row.contract?.plan === 'custom')) return;
    generation++;
    target = { ...row };
    units10 = row.contract?.extra_10gb_units ?? 0;
    units50 = row.contract?.extra_50gb_units ?? 0;
    interval = row.contract?.billing_interval ?? 'monthly';
    error = null;
    errors = {};
    submitting = false;
    reloadOnClose = false;
    dialog?.show(trigger);
  }
  $effect(() => () => {
    generation++;
  });
  $effect(() => {
    if (open || !reloadOnClose) return;
    reloadOnClose = false;
    void invalidateAll();
  });
  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!target || submitting || unchanged) return;
    errors = {};
    for (const [key, value] of [
      ['units10', units10],
      ['units50', units50],
    ] as const) {
      if (value === undefined || !Number.isInteger(value) || value < 0 || value > 100)
        errors[key] = t('operatorStorageUnitsError');
    }
    const firstInvalid = errors.units10 !== undefined ? '10' : errors.units50 !== undefined ? '50' : null;
    if (firstInvalid !== null) {
      document.getElementById(`${ids}-${firstInvalid}`)?.focus();
      return;
    }
    if (units10 === undefined || units50 === undefined) return;
    const mine = generation;
    submitting = true;
    error = null;
    try {
      const result = await callOperation(organizationStorageUpdate, {
        slug: target.slug,
        billing_interval: interval,
        extra_10gb_units: units10,
        extra_50gb_units: units50,
        expected: target.contract,
      });
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        onfinish('done');
      } else if (isUnauthenticated(result)) onfinish('unauthenticated');
      else if (result.status === 409) {
        open = false;
        onfinish(result.error?.code === 'purge_due' ? 'purge_due' : 'state_changed');
      } else if (result.status === 403 || result.status === 404) {
        open = false;
        onfinish('unavailable');
      } else if (result.status === 0 || result.status >= 500) {
        error = t('operatorStorageFailedUnknown');
        reloadOnClose = true;
      } else error = t('operatorStorageFailed');
    } finally {
      if (mine === generation) submitting = false;
    }
  }
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('operatorStorageTitle')}>
  <form id="{ids}-form" class="form" onsubmit={submit} novalidate>
    <p class="wrap-anywhere">{t('operatorStorageText', { name: target?.name ?? '' })}</p>
    <div class="form-fields">
      <div class="field" class:is-invalid={errors.units10 !== undefined}>
        <label class="field-label" for="{ids}-10">{t('operatorStorage10')}</label>
        <input
          class="input"
          id="{ids}-10"
          type="number"
          min="0"
          max="100"
          step="1"
          required
          bind:value={units10}
          readonly={submitting}
          oninput={() => {
            error = null;
            errors.units10 = undefined;
          }}
          aria-invalid={errors.units10 !== undefined}
          aria-describedby={errors.units10 !== undefined ? `${ids}-10-error ${ids}-hint` : `${ids}-hint`}
        />
        {#if errors.units10 !== undefined}<span class="field-error" id="{ids}-10-error" role="alert"
            ><Icon name="alert" />{errors.units10}</span
          >{/if}
      </div>
      <div class="field" class:is-invalid={errors.units50 !== undefined}>
        <label class="field-label" for="{ids}-50">{t('operatorStorage50')}</label>
        <input
          class="input"
          id="{ids}-50"
          type="number"
          min="0"
          max="100"
          step="1"
          required
          bind:value={units50}
          readonly={submitting}
          oninput={() => {
            error = null;
            errors.units50 = undefined;
          }}
          aria-invalid={errors.units50 !== undefined}
          aria-describedby={errors.units50 !== undefined ? `${ids}-50-error ${ids}-hint` : `${ids}-hint`}
        />
        {#if errors.units50 !== undefined}<span class="field-error" id="{ids}-50-error" role="alert"
            ><Icon name="alert" />{errors.units50}</span
          >{/if}
      </div>
      <p class="field-hint" id="{ids}-hint">{t('operatorStorageUnitsHint')}</p>
      {#if target?.kind === 'personal'}
        <div class="field">
          <span class="field-label" id="{ids}-interval">{t('operatorPlanIntervalChoices')}</span>
          <div class="choice-list" role="radiogroup" aria-labelledby="{ids}-interval">
            {#each billingIntervals as value (value)}
              <label class="choice"
                ><input type="radio" name="{ids}-interval" {value} bind:group={interval} disabled={submitting} />
                <div><b>{intervalNames[value]}</b></div></label
              >
            {/each}
          </div>
        </div>
        <p class="field-hint">{t('operatorStoragePersonalNote')}</p>
      {:else}
        <p class="field-hint">{t('operatorStorageTeamNote')}</p>
      {/if}
      <p class="field-hint" role="status">
        {#if valid}{t('operatorStorageAfter', { quota: sizeText(next.attachment_quota_bytes) })}{/if}
      </p>
      {#if unchanged}<p class="field-hint">{t('operatorStorageUnchanged')}</p>{/if}
      {#if valid && target?.kind === 'personal' && target.contract === null && next.attachment_quota_bytes < target.attachment_quota_bytes}
        <div class="callout is-warn">
          <Icon name="alert" /><span
            >{t('operatorStoragePersonalLower', {
              current: sizeText(target.attachment_quota_bytes),
              next: sizeText(next.attachment_quota_bytes),
            })}</span
          >
        </div>
      {/if}
      {#if valid && target !== null && next.attachment_quota_bytes < target.attachment_used_bytes}
        <div class="callout is-warn"><Icon name="alert" /><span>{t('operatorStorageBelowUsage')}</span></div>
      {/if}
      {#if target?.suspended_at}<p class="field-hint">
          {t('operatorStorageSuspendedNote')}
        </p>{/if}
      <p class="field-hint">{t('operatorStorageHistoryNote')}</p>
    </div>
    {#if error}<div class="callout is-danger" role="alert"><Icon name="alert" /><span>{error}</span></div>{/if}
  </form>
  <span class="visually-hidden" role="status">{submitting ? t('operatorChanging') : ''}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form="{ids}-form" aria-disabled={submitting || unchanged}
      >{submitting ? t('operatorChanging') : t('operatorChangeSubmit')}</button
    >
  {/snippet}
</Dialog>
