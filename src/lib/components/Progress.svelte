<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の progress。目盛りは任意。style 指令（CSSOM）で CSP の下でも位置を渡す。
  let {
    done,
    all,
    markerPercent,
    markerLabel,
    detailed = false,
  }: {
    done: number;
    all: number;
    markerPercent?: number;
    markerLabel?: string;
    detailed?: boolean;
  } = $props();

  const percent = $derived(all > 0 ? Math.min(100, Math.round((done / all) * 100)) : 0);
  const marker = $derived(markerPercent === undefined ? undefined : Math.max(0, Math.min(100, markerPercent)));
  const value = $derived(
    detailed
      ? t(all > 0 ? 'progressCompletedPercent' : 'progressCompleted', { done: t('done'), value: done, all, percent })
      : t('progressValue', { value: done, all }),
  );
  const label = $derived(
    detailed ? value : t('progressLabel', { done: t('done'), value: done, all, points: t('points') }),
  );
</script>

<span class="progress" class:is-detailed={detailed}>
  <span
    class="progress-bar"
    class:has-marker={marker !== undefined}
    role="img"
    aria-label={marker !== undefined && markerLabel ? `${label}、${markerLabel}` : label}
  >
    <span class="progress-fill" style:width={`${percent}%`}></span>
    {#if marker !== undefined}
      <i class="progress-marker" style:left={`${marker}%`} aria-hidden="true"></i>
    {/if}
  </span>
  <span class="progress-num"
    >{#if detailed}<span>{t('done')}</span>
      <span class="progress-value">{t('progressValue', { value: done, all })}</span>{#if all > 0}<span
          class="progress-value">{t('progressPercent', { percent })}</span
        >{/if}{:else}{value}{/if}</span
  >
  {#if marker !== undefined && markerLabel}<span class="progress-legend">{markerLabel}</span>{/if}
</span>
