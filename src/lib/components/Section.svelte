<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の section と foldedSection（level は見出しの段。既定は 2、面（Pane）の中に置く節は 3。folded。閉じた区分で、見出しの行を押すと開く。見出しの右に「開くと一覧を表示」を出し、開いたら CSS が隠す）。id は見出しと節を結ぶ（aria-labelledby）ので、画面の中で一意にする
  let {
    id,
    title,
    count,
    hint,
    folded = false,
    level = 2,
    children,
  }: {
    id: string;
    title: string;
    count?: number;
    hint?: string;
    folded?: boolean;
    level?: 2 | 3;
    children: Snippet;
  } = $props();
</script>

{#if folded}
  <details class="section is-folded">
    <summary class="section-head">
      <svelte:element this={level === 3 ? 'h3' : 'h2'} class="section-title" {id}>{title}</svelte:element>
      {#if count != null}<span class="section-count">{count} {t('countUnit')}</span>{/if}
      <span class="section-hint">{t('sectionOpen')}</span>
    </summary>
    {@render children()}
  </details>
{:else}
  <section class="section" aria-labelledby={id}>
    <div class="section-head">
      <svelte:element this={level === 3 ? 'h3' : 'h2'} class="section-title" {id}>{title}</svelte:element>
      {#if count != null}<span class="section-count">{count} {t('countUnit')}</span>{/if}
      {#if hint}<span class="section-hint">{hint}</span>{/if}
    </div>
    {@render children()}
  </section>
{/if}
