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
  // tone="warn" は印（mark のアイコン）と枠の色で注意を示す。色だけに頼らないよう、label に同じことを含める。
  // align="start" は小窓をボタンの左端にそろえる（帯の左の絞り込み）。active は選んでいる値があることを枠と文字の色で示す
  // （色だけに頼らないよう、text と label に数を含める）
  let {
    text,
    label,
    dialogLabel,
    icon,
    tone,
    note,
    align = 'end',
    active = false,
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
    // 文字の後ろに添える短い状態の言葉（期限切れなど）。色だけに頼らず、見える言葉でも示す。
    // 読み上げの名前（label）には「<文字> <note>」の形で含める（見える文字の前に空白を置き、名前と見える文字をそろえる）
    note?: string;
    align?: 'start' | 'end';
    active?: boolean;
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
    // 地を押すとブラウザが押し下げ（mousedown）でフォーカスを外すので、離した後にボタンへ戻す。
    // どちらかが来たら両方を外す（残すと、後の別の操作の離しでフォーカスを奪う）。押しが取り消された（スクロールになった）ときは戻さない
    const done = (event: PointerEvent): void => {
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      if (event.type === 'pointerup') button?.focus({ preventScroll: true });
    };
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<!-- キーは中のボタンと小窓から届く。包む要素そのものはフォーカスを受けない -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="popover" class:is-start={align === 'start'} bind:this={root} onkeydown={onKeydown} onfocusout={onFocusOut}>
  <button
    class="btn popover-btn"
    class:is-warn={tone === 'warn'}
    class:is-active={active}
    type="button"
    bind:this={button}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={label}
    title={label}
    onclick={() => (open ? close(true) : void show())}
  >
    {#if icon}<Icon name={icon} />{/if}<span class="popover-btn-text">{text}</span>{#if note}<span
        class="popover-btn-note">&#32;{note}</span
      >{/if}<Icon name="chevron" />
  </button>
  {#if open && button}
    <div class="popover-panel" role="dialog" aria-label={dialogLabel} tabindex="-1" bind:this={panel}>
      {@render children(close, button)}
    </div>
  {/if}
</span>
