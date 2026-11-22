<script lang="ts">
  import type { EpicRewardTier } from '../../shared/experience.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の tier。クリア報酬の段階と額の印（components.css の .tier）。額（xp）は渡したときだけ出す（クリア報酬の段階を選ぶダイアログ）。
  // 色だけに頼らず、段階の呼び名（小、中、大）を文字で添える。エピックの画面は経験値を出さない（#1432）
  let { tier, xp }: { tier: EpicRewardTier; xp?: number } = $props();

  // {#if} の中の先頭の空白は Svelte が詰めるので、区切りは値で渡す（読み上げの名前が「小 · 100 XP」になる）
  const separator = ' · ';

  const label = $derived(
    tier === 'small' ? t('epicTierSmall') : tier === 'medium' ? t('epicTierMedium') : t('epicTierLarge'),
  );
</script>

<span class="tier is-{tier}"
  >{label}{#if xp !== undefined}{separator}<b>{xp}</b> {t('xpUnit')}{/if}</span
>
