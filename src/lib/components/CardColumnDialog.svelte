<script lang="ts">
  import { tick } from 'svelte';
  import type { SprintBoardColumn, SprintBoardTask } from '../../shared/operations/sprint/index.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';

  // ボードのカードの「⋯」の「列を変更」で開く、移す先の列を選ぶダイアログ（#1500。形は親を移すダイアログ MoveParentDialog と同じ）。
  // 候補は、今の列を除いた列（完了の列は最後で、名前は辞書の「完了」）。show(trigger, task, columnId) で、動かすカードと今の列を渡して開く。
  // 「移す」を押したら閉じて、onmove に動かすカードと選んだ列を渡す。選んだ列の末尾に置き、完了の列なら完了にするのは画面が持つ
  let {
    columns,
    onmove,
  }: {
    columns: readonly SprintBoardColumn[];
    onmove: (task: SprintBoardTask, columnId: string) => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const targetId = `${ids}-target`;
  const hintId = `${ids}-hint`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  // 動かすカード。送ったら空にして、閉じるまでの2回目の送信を無視する。見出しの題は閉じるまで残す
  let item = $state<SprintBoardTask | null>(null);
  let heading = $state('');
  let current = $state<string | null>(null);
  let choice = $state('');

  const candidates = $derived(columns.filter((column) => column.id !== current));

  function nameOf(column: SprintBoardColumn): string {
    return column.is_done ? t('done') : (column.name ?? '');
  }

  export function show(trigger: HTMLElement | null, target: SprintBoardTask, columnId: string): void {
    item = target;
    heading = target.title;
    current = columnId;
    // 今の列の次の列を選んでおく（「次の列へ」と同じ向き）。次が完了の列か無ければ、完了でない最初の候補
    // （開いてすぐの Enter で、気づかずに完了にしないため）
    const at = columns.findIndex((column) => column.id === columnId);
    const next = columns[at + 1];
    choice =
      next !== undefined && !next.is_done
        ? next.id
        : (columns.find((column) => column.id !== columnId && !column.is_done)?.id ?? candidates[0]?.id ?? '');
    dialog?.show(trigger);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (item === null) return;
    const moving = item;
    const columnId = choice;
    item = null;
    open = false;
    if (columnId === '' || columnId === current) return;
    // ダイアログが閉じて画面に戻ってから渡す（画面が、移した先のカードへフォーカスを移せるように）
    await tick();
    onmove(moving, columnId);
  }
</script>

<Dialog bind:this={dialog} bind:open title={t('cardColumnChangeTitle', { title: heading, column: t('column') })}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <div class="field">
      <label class="field-label" for={targetId}>{t('cardColumnChangeField', { column: t('column') })}</label>
      <select class="select" id={targetId} bind:value={choice} aria-describedby={hintId}>
        {#each candidates as column (column.id)}
          <option value={column.id}>{nameOf(column)}</option>
        {/each}
      </select>
      <span class="field-hint" id={hintId}
        >{t('cardColumnChangeHint', { column: t('column'), done: t('done'), task: t('task') })}</span
      >
    </div>
  </form>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form={formId}>{t('cardColumnChangeSubmit')}</button>
  {/snippet}
</Dialog>
