<script lang="ts">
  import type { OutputOf } from '../../shared/operations/define.ts';
  import type { billingOrganizationSummary } from '../../shared/operations/billing.ts';
  import { formatCount, quotaSize } from '../format.ts';
  import { formatTrialStopDateTime } from '../format-datetime.ts';
  import { billingStateKeys, planLabel, planTermsText } from '../plan-terms.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 請求画面の「契約と使用量」（design/billing.html の summary）。担当組織の契約、利用の状態、人数と容量の使用量を上限と並べて出す。
  // 使用量は組織全体の合計の2値だけで、内訳やワークスペースの名前は受け取らない（docs/requirements.md の「請求管理者（#1241）」）。
  // 契約の語は組織の管理のプランの節（PlanDetails.svelte）と同じ。個別契約は人数と標準容量も添える（planTermsText）。
  // 変えるのは運用者なので、問い合わせの案内を出す
  type Summary = OutputOf<typeof billingOrganizationSummary>;
  let { summary }: { summary: Summary } = $props();

  const contract = $derived(summary.contract);
  const extras = $derived(
    contract === null
      ? []
      : [
          { size: 10, units: contract.extra_10gb_units },
          { size: 50, units: contract.extra_50gb_units },
        ].filter((extra) => extra.units > 0),
  );
  // お試しは期限の UTC の日付の翌日 0 時から止まる（formatTrialStopDateTime）。過ぎていれば「止まります」と未来形で出さない
  // （期限切れで止まった組織も、再開するまで trial_ends_on が残る）
  const trialExpired = $derived(
    summary.trial_ends_on !== null && Date.parse(`${summary.trial_ends_on}T00:00:00Z`) + 86_400_000 <= Date.now(),
  );
  function limitText(bytes: number): string {
    const quota = quotaSize(bytes);
    return t(quota.unit === 'gb' ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', { size: quota.size });
  }
  // 使った量は、上限の直前を上限と同じ値に丸めて満杯と見間違えないよう、容量の節（StorageSetting.svelte）と同じく小数1桁で切り捨てる
  function usedText(bytes: number): string {
    if (bytes < 1024 ** 2) return t('storageByteSize', { size: formatCount(bytes) });
    const unit = bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
    return t(unit === 1024 ** 3 ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', {
      // 割り算の誤差で 0.1 小さく出ないよう、整数のまま切り捨ててから10で割る
      size: formatCount(Math.floor((bytes * 10) / unit) / 10),
    });
  }
</script>

<dl class="props">
  <div>
    <dt>{t('billingStateLabel')}</dt>
    <dd>
      <span class="chip" class:is-warn={summary.state !== 'active'}>{t(billingStateKeys[summary.state])}</span>
      {#if summary.purge_on !== null && summary.purge_due}<span class="chip is-danger"
          ><Icon name="alert" />{t('billingPurgeDue', { date: summary.purge_on })}</span
        >
      {:else if summary.purge_on !== null}<span class="props-note"
          >{t('billingPurgeOn', { date: summary.purge_on })}</span
        >{/if}
    </dd>
  </div>
  {#if summary.trial_ends_on !== null}
    <div>
      <dt>{t('billingTrialLabel')}</dt>
      <dd class="mono">
        {trialExpired
          ? t('trialExpired')
          : t('orgTrialEndsOn', { datetime: formatTrialStopDateTime(summary.trial_ends_on) })}
      </dd>
    </div>
  {/if}
  <div>
    <dt>{t('orgPlanTermsLabel')}</dt>
    <dd>
      {#if contract === null && summary.kind === 'team'}<span class="chip">{t('operatorPlanNone')}</span>
      {:else if contract !== null}{planTermsText(contract, t)}
      {:else}{planLabel({ kind: summary.kind, contract }, t)}{/if}
    </dd>
  </div>
  {#if contract !== null}
    <div>
      <dt>{t('orgPlanExtraLabel')}</dt>
      <dd>
        {#if extras.length === 0}{t('orgPlanExtraNone')}
        {:else}{extras
            .map((extra) => t('orgPlanExtraUnits', { size: extra.size, units: formatCount(extra.units) }))
            .join('、')}{/if}
      </dd>
    </div>
  {/if}
  <div>
    <dt>{t('billingUsageSeatsLabel')}</dt>
    <dd class="mono">
      {t('billingUsageSeats', {
        used: formatCount(summary.usage.seats_used),
        limit: formatCount(summary.member_limit),
      })}
    </dd>
  </div>
  <div>
    <dt>{t('billingUsageStorageLabel')}</dt>
    <dd class="mono">
      {t('billingUsageStorage', {
        used: usedText(summary.usage.attachment_used_bytes),
        quota: limitText(summary.attachment_quota_bytes),
      })}
    </dd>
  </div>
</dl>
{#if summary.kind === 'personal'}<p class="props-note">
    {t('orgPlanPersonalNote', { organization: t('organization') })}
  </p>
{:else if contract === null}<p class="props-note">{t('orgPlanNoneNote')}</p>{/if}
<p class="props-note">{t('billingUsageNote', { organization: t('organization') })}</p>
<div class="callout is-info">
  <Icon name="mail" /><span>{t(summary.kind === 'personal' ? 'orgPlanContactPersonal' : 'orgPlanContact')}</span>
</div>
