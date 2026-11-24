<script lang="ts">
  import { asset } from '$app/paths';
</script>

<!-- kit.js の brandSymbol と同じ画像。上の帯の左端（開閉のボタンの右）に置くマーク単体。読み上げ名は呼び出し元が受け持つ -->
<span class="brand-art is-symbol" aria-hidden="true">
  <img class="brand-mark" src={asset('brand/master/symbol.webp')} width="629" height="678" alt="" />
</span>
