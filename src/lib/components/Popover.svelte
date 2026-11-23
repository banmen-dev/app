<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import type { IconName } from '../icons.ts';
  import Icon from './Icon.svelte';

  // kit.js の popover（components.css の .popover）。押すと、ボタンの下の右端にそろえた小窓（role="dialog"。モーダルにしない）を開く。
  // 開くと小窓そのものへフォーカスを移す（中の文から読めるように）。Esc で閉じてボタンへフォーカスを戻す。
  // 小窓の外を押すと閉じ、フォーカスの行き先が無ければ（地を押した）ボタンへ戻す。外のボタンや欄を押したときは、その押した先に残す。
  // Tab で小窓の外へ出たときは閉じるだけで、出た先に残す。
  // children には、小窓を閉じる関数と、ボタンの要素を渡す。中の操作でダイアログを開くときは、close(false) で閉じてから
  // ボタンをダイアログの戻り先に渡す（小窓は閉じて消えるので、中のボタンへは戻せない）。
  // tone="warn" は印（mark のアイコン）と枠の色で注意を示す。色だけに頼らないよう、label に同じことを含める
  let {
    text,
    label,
    dialogLabel,
    icon,
    tone,
    children,
  }: {
    // ボタンの見える文字
    text: string;
    // ボタンの読み上げの名前。見える文字を含める
    label: string;
    // 小窓の読み上げの名前
    dialogLabel: string;
    // 文字の前に置くアイコン。tone を付けたときは印として色を付ける
    icon?: IconName;
    tone?: 'warn';
    children: Snippet<[(restoreFocus: boolean) => void, HTMLElement]>;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();
  let panel = $state<HTMLElement>();

  async function show(): Promise<void> {
    open = true;
    await tick();
    panel?.focus();
  }

  function close(restoreFocus: boolean): void {
    if (!open) return;
    open = false;
    if (restoreFocus) button?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }

  function onFocusOut(event: FocusEvent): void {
    if (!open) return;
    const next = event.relatedTarget;
    // 行き先が無い（地を押した）ときは、外を押したときの扱い（onWindowClick）に任せる
    if (next === null || (next instanceof Node && root?.contains(next))) return;
    close(false);
  }

  function onWindowClick(event: MouseEvent): void {
    if (!open || !root || !(event.target instanceof Node) || root.contains(event.target)) return;
    const active = document.activeElement;
    close(active === null || active === document.body || (panel?.contains(active) ?? false));
  }
</script>

<svelte:window onclick={onWindowClick} />

<!-- キーは中のボタンと小窓から届く。包む要素そのものはフォーカスを受けない -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="popover" bind:this={root} onkeydown={onKeydown} onfocusout={onFocusOut}>
  <button
    class="btn popover-btn"
    class:is-warn={tone === 'warn'}
    type="button"
    bind:this={button}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={label}
    title={label}
    onclick={() => (open ? close(true) : void show())}
  >
    {#if icon}<Icon name={icon} />{/if}<span class="popover-btn-text">{text}</span><Icon name="chevron" />
  </button>
  {#if open && button}
    <div class="popover-panel" role="dialog" aria-label={dialogLabel} tabindex="-1" bind:this={panel}>
      {@render children(close, button)}
    </div>
  {/if}
</span>
