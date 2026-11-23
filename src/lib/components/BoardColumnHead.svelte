<script lang="ts" module>
  import type { ApiResult } from '../api.ts';

  // リーダー（管理者を含む）が、終了していないワークスペースの完了でない列で使う配線。無ければ見出しは読むだけ
  export interface BoardColumnLead {
    slug: string;
    workspaceId: string;
    // 左へ移すときの column-move の after_column_id（null は先頭）。undefined は左端で移せない
    leftAfter: string | null | undefined;
    // 右へ移すときの after_column_id。undefined は右端（完了の列の手前）で移せない
    rightAfter: string | undefined;
    // 左から何番目へ移るか（読み上げとトースト）
    leftPosition: number;
    rightPosition: number;
    // 上限のダイアログを開く
    onlimit: (trigger: HTMLElement) => void;
    // 書いた後に盤を読み直す
    onchanged: () => Promise<void>;
    // 断られた（400 のほか）。理由をトーストで出して読み直す
    onfailed: (result: ApiResult<unknown>) => void;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { COLUMN_NAME_MAX_LENGTH, columnNameProblem, overWipLimit } from '../../shared/column.ts';
  import { columnConflictReasonOf, columnMove, columnUpdate } from '../../shared/operations/column/index.ts';
  import type { SprintBoardColumn } from '../../shared/operations/sprint/index.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import RowMenu, { type RowMenuItem } from './RowMenu.svelte';

  // ボードの列の見出し（見本は kit.js の board の列の頭）。開閉、名前、件数の札、ポイントの合計を1行に並べる。
  // 上限（wip_limit）があれば札を「件数 / 上限」にし、超えたら警告の色（.is-over）と、読み上げの「上限の N 件を超えています」にする。
  // 件数は絞り込みに関わらず列の全件で上限と比べる（上限は列の仕掛かりの目安のため）。
  // lead があれば、名前を押すと入力欄に替わり（Enter かフォーカスが外れたら column-update の name で保存、Esc で戻す。
  // 使えない名前と同じ名前は理由をトーストで出す）、右端の「⋯」から名前の変更、上限、左右への移動を選べる
  let {
    column,
    name,
    count,
    total,
    points,
    collapsed,
    ontoggle,
    lead,
  }: {
    column: SprintBoardColumn;
    // 出す名前（完了の列は辞書の名前）
    name: string;
    // 見えているカードの数（ストーリーで絞っていれば絞った数）
    count: number;
    // 列の全件（上限と比べる）
    total: number;
    points: number;
    collapsed: boolean;
    ontoggle: () => void;
    lead?: BoardColumnLead;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  // 送っている間に出す名前。null は column.name
  let sending = $state<string | null>(null);
  let busy = $state(false);
  let input = $state<HTMLInputElement>();
  let nameButton = $state<HTMLButtonElement>();
  let menu = $state<ReturnType<typeof RowMenu>>();

  const shownName = $derived(sending ?? name);
  const limit = $derived(column.wip_limit);
  const over = $derived(overWipLimit(total, limit));
  const countLabel = $derived(
    limit === null
      ? t('boardColumnCountLabel', { count })
      : over
        ? t('boardColumnCountOver', { count: total, limit })
        : t('boardColumnCountWithin', { count: total, limit }),
  );

  // 書き込めなくなった（ワークスペースが終了した、リーダーでなくなった）ら、欄を閉じて書きかけを捨てる
  $effect(() => {
    if (lead === undefined) editing = false;
  });

  function nameMessage(raw: string): string | null {
    const problem = columnNameProblem(raw);
    if (problem === 'required') return t('columnNameRequired');
    if (problem === 'too_long') return t('columnNameTooLong', { max: COLUMN_NAME_MAX_LENGTH });
    if (problem === 'invalid_character') return t('columnNameInvalidCharacter');
    return null;
  }

  export async function beginRename(): Promise<void> {
    if (lead === undefined || sending !== null) return;
    draft = name;
    editing = true;
    await tick();
    input?.focus();
    input?.select();
  }

  // restoreFocus はキー（Enter と Esc）で終えたときだけ真。フォーカスが外れて終えたときは、移った先から奪わない
  async function endRename(restoreFocus: boolean): Promise<void> {
    editing = false;
    if (!restoreFocus) return;
    await tick();
    nameButton?.focus();
  }

  async function commitRename(byKey: boolean): Promise<void> {
    if (!editing) return;
    const wiring = lead;
    const next = draft.trim();
    if (wiring === undefined || next === name) {
      await endRename(byKey);
      return;
    }
    const problem = nameMessage(next);
    if (problem !== null) {
      showToast(problem, 'alert');
      // Enter では欄に留めて直してもらう。外れたときは欄へ引き戻さず、元の名前に戻す
      if (!byKey) await endRename(false);
      return;
    }
    await endRename(byKey);
    sending = next;
    try {
      const result = await callOperation(
        columnUpdate,
        { workspace_id: wiring.workspaceId, column_id: column.id, name: next },
        { slug: wiring.slug },
      );
      if (result.ok) {
        await wiring.onchanged();
        return;
      }
      if (result.status === 409 && result.error?.code === 'conflict') {
        const reason = columnConflictReasonOf(result.error.details);
        if (reason === 'duplicate_name') {
          showToast(t('definitionDuplicate', { kind: t('column') }), 'alert');
          return;
        }
        if (reason === 'changed') {
          showToast(t('columnSaveChanged'), 'alert');
          await wiring.onchanged();
          return;
        }
      }
      if (result.status === 400) {
        showToast(t('definitionBadRequest'), 'alert');
        return;
      }
      wiring.onfailed(result);
    } finally {
      sending = null;
    }
  }

  function nameKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void endRename(true);
    }
  }

  async function move(afterId: string | null, position: number): Promise<void> {
    const wiring = lead;
    if (wiring === undefined || busy) return;
    busy = true;
    try {
      const result = await callOperation(
        columnMove,
        { workspace_id: wiring.workspaceId, column_id: column.id, after_column_id: afterId },
        { slug: wiring.slug },
      );
      if (!result.ok) {
        if (result.status === 409 && result.error?.code === 'conflict') {
          showToast(t('columnSaveChanged'), 'alert');
          await wiring.onchanged();
        } else wiring.onfailed(result);
        return;
      }
      await wiring.onchanged();
      showToast(t('boardColumnMoved', { name, position }), 'check');
      // 並びが変わると見出しの要素が動き、フォーカスを失いうる。動いた列の「⋯」へ戻す
      await tick();
      menu?.focus();
    } finally {
      busy = false;
    }
  }

  const items = $derived.by((): RowMenuItem[] => {
    if (lead === undefined) return [];
    const { leftAfter, rightAfter, leftPosition, rightPosition, onlimit } = lead;
    return [
      { key: 'rename', label: t('boardColumnRename'), icon: 'pen', onselect: () => void beginRename() },
      { key: 'limit', label: t('boardColumnLimitAction'), icon: 'gear', onselect: (trigger) => onlimit(trigger) },
      {
        key: 'left',
        label: t('boardColumnMoveLeft'),
        icon: 'left',
        disabled: leftAfter === undefined || busy,
        onselect: () => {
          if (leftAfter !== undefined) void move(leftAfter, leftPosition);
        },
      },
      {
        key: 'right',
        label: t('boardColumnMoveRight'),
        icon: 'right',
        disabled: rightAfter === undefined || busy,
        onselect: () => {
          if (rightAfter !== undefined) void move(rightAfter, rightPosition);
        },
      },
    ];
  });
</script>

<div class="board-col-head">
  <button
    class="board-col-toggle"
    type="button"
    data-column-toggle={column.id}
    aria-label={t('sprintBoardColumnToggle', { column: name })}
    aria-expanded={!collapsed}
    onclick={ontoggle}><Icon name="chevron" /></button
  >
  {#if column.is_done}<Icon name="check" />{/if}
  {#if editing}
    <input
      class="input board-col-name-input"
      type="text"
      autocomplete="off"
      aria-label={t('boardColumnNameField', { column: t('column') })}
      bind:this={input}
      bind:value={draft}
      onkeydown={nameKeydown}
      onblur={() => void commitRename(false)}
    />
  {:else if lead !== undefined}
    <button
      class="board-col-name is-action"
      type="button"
      bind:this={nameButton}
      aria-label={t('boardColumnRenameLabel', { column: t('column'), name: shownName })}
      title={t('boardColumnRenameLabel', { column: t('column'), name: shownName })}
      aria-disabled={sending !== null ? 'true' : undefined}
      onclick={() => void beginRename()}>{shownName}</button
    >
  {:else}
    <span class="board-col-name">{shownName}</span>
  {/if}
  <!-- 見た目の札は数だけ（読み上げは隣の文）。札の文字は「件数」か「件数 / 上限」 -->
  <span class="board-col-n" class:is-over={over} aria-hidden="true"
    >{#if over}<Icon name="alert" />{/if}{limit === null ? count : `${total} / ${limit}`}</span
  ><span class="visually-hidden">{countLabel}</span>
  <span class="board-col-pts">{t('sprintBoardColumnPoints', { points })}</span>
  {#if lead !== undefined}
    <RowMenu bind:this={menu} title={t('boardColumnMenu', { column: t('column'), name: shownName })} {items} />
  {/if}
</div>
