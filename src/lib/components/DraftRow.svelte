<script module lang="ts">
  export class DraftRowState {
    value = $state('');
    error = $state<string | null>(null);
    sending = $state(false);
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // バックログの木の空の行（デザインシステムの .draft-row。見本は design/kit.js の draftRow）。題を打って Enter で作る。エピックの末尾、木の末尾に置く。
  // 何を作る行かは、欄の案内文（label に「（題を打って Enter）」を添えたもの）で示す。読み上げの名前（name）は、親の題を添えて同じ名前の行を区別する。
  // create は作る処理で、エラーの文（画面に出す）か、成功の null を返す。成功したら入力を空に戻し、フォーカスを残して続けて打てる。
  // 日本語の変換中の Enter は確定なので作らず、変換中の Esc は変換の取り消しなので素通しする（Safari は確定の Enter の前に compositionend を出すので、keyCode 229 も見る）。
  // 変換中でない Esc は書きかけを捨てる（フォーカスは欄に残す。preventDefault するので、引き出しは閉じない）。
  // 空のまま Enter を押しても、離れても、何も送らない。書きかけで離れたときは、書きかけを残す（自動では作らない）。
  // 送っている間は欄を readonly にしてフォーカスを残し、読み上げの領域に「作っています」を出す。
  // attrs を渡すと（ボードの列の末尾。#1501）、題の欄の下に作る前に選ぶ属性（担当と期日のチップ）を置く。値は呼び出し側が持ち、
  // 作れたら呼び出し側が空に戻す。送っている間かどうかを渡す（チップを押せなくする）。Esc で書きかけを捨てるときは ondiscard も呼ぶ。
  let {
    label,
    name = label,
    problem,
    create,
    keyshortcut,
    placeholder,
    describedby,
    attrs,
    ondiscard,
    draft = new DraftRowState(),
  }: {
    // 外から `c` などでフォーカスを移せるときの、そのキー（aria-keyshortcuts で読み上げに伝える。フォーカスが移る先の欄に付ける）
    keyshortcut?: string;
    // 入力の補足説明があるときの要素ID。検査エラーの説明と併用する。
    describedby?: string;
    // 行に見える文（「<ストーリー>を足す」など）
    label: string;
    // 欄の案内文。省けば label に「（題を打って Enter）」を添える。列幅が狭い欄（スプリントの列）は、切れない短い文を渡す
    placeholder?: string;
    // 読み上げの名前。省けば label
    name?: string;
    // 画面の検査。エラーの文か、null
    problem: (title: string) => string | null;
    create: (title: string) => Promise<string | null>;
    // 題の欄の下に並べる、作る前に選ぶ属性。引数は送っている間か
    attrs?: Snippet<[boolean]>;
    // Esc で書きかけを捨てたとき（属性の選択も捨てるため）
    ondiscard?: () => void;
    draft?: DraftRowState;
  } = $props();

  const ids = $props.id();
  const inputId = `${ids}-input`;
  const errorId = `${ids}-error`;

  let input = $state<HTMLInputElement>();

  // 外（`c` のショートカットなど）から欄へフォーカスを移す。見える位置へ寄せる
  export function focus(): void {
    input?.focus();
    input?.scrollIntoView?.({ block: 'nearest' });
  }

  async function submit(): Promise<void> {
    if (draft.sending) return;
    const title = draft.value.trim();
    if (title === '') return;
    const found = problem(title);
    if (found !== null) {
      draft.error = found;
      return;
    }
    draft.error = null;
    draft.sending = true;
    try {
      const failed = await create(title);
      if (failed === null) {
        draft.value = '';
      } else {
        draft.error = failed;
      }
    } finally {
      draft.sending = false;
      await tick();
      input?.focus();
    }
  }

  function keydown(event: KeyboardEvent): void {
    // 変換中のキーは、ここで扱わない（Safari は確定の Enter で isComposing が偽、keyCode が 229 になる）
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // 送っている間は捨てられない（送信は止まらないので、捨てたつもりで作られるのを避ける）
      if (draft.sending) return;
      draft.value = '';
      draft.error = null;
      ondiscard?.();
    }
  }
</script>

<div class="draft-row" data-draft-row>
  <Icon name="plus" />
  <label class="visually-hidden" for={inputId}>{name}</label>
  <input
    id={inputId}
    bind:this={input}
    bind:value={draft.value}
    class="input"
    type="text"
    autocomplete="off"
    enterkeyhint="done"
    aria-keyshortcuts={keyshortcut}
    placeholder={placeholder ?? t('draftPlaceholder', { label })}
    readonly={draft.sending}
    aria-invalid={draft.error !== null}
    aria-describedby={[describedby, draft.error === null ? undefined : errorId].filter(Boolean).join(' ') || undefined}
    oninput={() => (draft.error = null)}
    onkeydown={keydown}
  />
</div>
<span class="visually-hidden" role="status">{draft.sending ? t('treeAddSending') : ''}</span>
{#if draft.error !== null}
  <p class="field-error draft-error" id={errorId} role="alert">{draft.error}</p>
{/if}
<!-- 属性は題の失敗の文の後に置く（失敗の文を題の欄のすぐ下に読ませる） -->
{#if attrs !== undefined}{@render attrs(draft.sending)}{/if}
