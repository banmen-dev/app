<script lang="ts">
  import type { IconName } from '../icons.ts';

  // kit.js の icon
  let { name }: { name: IconName } = $props();
</script>

<svg class="ico" aria-hidden="true"><use href="#i-{name}" /></svg>
