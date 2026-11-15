<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の pane（見出しと中身を持つ枠。組織のホームの面）。id は見出しと面を結ぶ（aria-labelledby）ので、画面の中で一意にする。
  // count は見出しの横の件数、hint は補足。中身（children）は .pane-body に入り、中の節（Section）は level={3} にする
  let {
    id,
    title,
    count,
    hint,
    children,
  }: {
    id: string;
    title: string;
    count?: number;
    hint?: string;
    children: Snippet;
  } = $props();
</script>

<section class="pane" aria-labelledby={id}>
  <div class="pane-head">
    <h2 class="pane-title" {id}>{title}</h2>
    {#if count != null}<span class="pane-count">{count} {t('countUnit')}</span>{/if}
    {#if hint}<span class="pane-hint">{hint}</span>{/if}
  </div>
  <div class="pane-body">{@render children()}</div>
</section>
