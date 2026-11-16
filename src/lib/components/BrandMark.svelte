<script lang="ts">
  import { asset } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
</script>

<!-- kit.js の brandMark と同じ構成。読み上げ名は呼び出し元が受け持つ -->
<span class="brand-art" aria-hidden="true">
  <img class="brand-mark" src={asset('brand/master/symbol.png')} width="629" height="678" alt="" />
  <span class="brand-name">{t('brandName')}</span>
</span>
