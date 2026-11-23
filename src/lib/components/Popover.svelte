<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import type { IconName } from '../icons.ts';
  import Icon from './Icon.svelte';

  // kit.js の popover（components.css の .popover）。押すと、ボタンの下の右端にそろえた小窓（role="dialog"。モーダルにしない）を開く。
  // 開くと小窓そのものへフォーカスを移す（中の文から読めるように）。Esc で閉じてボタンへフォーカスを戻す。
  // 小窓の外を押すと閉じ、地を押したときはボタンへ戻す。外のボタンや欄を押したときは、その押した先に任せる。
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
    note,
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
    // 文字の後ろに添える短い状態の言葉（期限切れなど）。色だけに頼らず、見える言葉でも示す
    note?: string;
    children: Snippet<[(restoreFocus: boolean) => void, HTMLElement]>;
  } = $props();

  const CONTROLS = 'a[href], button, input, select, textarea, summary, label, [tabindex], [contenteditable="true"]';
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
    // 行き先が無い（地を押した）ときは、外を押したときの扱い（onWindowPointerDown）に任せる
    if (next === null || (next instanceof Node && root?.contains(next))) return;
    close(false);
  }

  // 外を押したかは、押し始め（pointerdown）で決める。click で決めると、小窓の中の文をなぞって外で離したときに閉じ、
  // iOS の Safari では押せない要素を押しても click が来ない。押した先が操作の要素なら、その要素にフォーカスを任せて戻さない
  // （Safari と macOS の Firefox は、ボタンを押してもフォーカスを移さないので、フォーカスの位置では見分けられない）
  function onWindowPointerDown(event: PointerEvent): void {
    if (!open || !root || !(event.target instanceof Element) || root.contains(event.target)) return;
    close(false);
    if (event.target.closest(CONTROLS) !== null) return;
    // 地を押すとブラウザが押し下げ（mousedown）でフォーカスを外すので、離した後にボタンへ戻す
    const restore = (): void => button?.focus();
    window.addEventListener('pointerup', restore, { once: true });
    window.addEventListener('pointercancel', restore, { once: true });
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

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
    {#if icon}<Icon name={icon} />{/if}<span class="popover-btn-text">{text}</span>{#if note}<span
        class="popover-btn-note">{note}</span
      >{/if}<Icon name="chevron" />
  </button>
  {#if open && button}
    <div class="popover-panel" role="dialog" aria-label={dialogLabel} tabindex="-1" bind:this={panel}>
      {@render children(close, button)}
    </div>
  {/if}
</span>
