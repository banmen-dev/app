<script lang="ts">
  import { COLUMN_WIP_LIMIT_MAX, COLUMN_WIP_LIMIT_MIN } from '../../shared/column.ts';
  import { columnUpdate } from '../../shared/operations/column/index.ts';
  import { callOperation, type ApiResult } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // 欄は type="text" と inputmode="numeric" にし、打った文字のまま parse で確かめる（type="number" は数として読めない入力を
  // 空として返し、上限を外す操作と見分けられないため）。
  // ボードの列の上限を決めるダイアログ（見本は kit.js の DIALOGS.columnLimit）。数を入れて「決める」で column-update の wip_limit を送り、
  // 空にして決めると上限を外す（null）。1〜99 の整数のほかは欄の下に理由を出して送らない。
  // 通ったら閉じてトーストを出し、onsaved で盤を読み直す。断られたら、閉じずに済む理由（400）は欄に、ほかは onfailed に渡して閉じる
  let {
    slug,
    workspaceId,
    onsaved,
    onfailed,
  }: {
    slug: string;
    workspaceId: string;
    onsaved: () => void;
    // 400 のほか（404、403、409 など）。呼ぶ側が理由をトーストで出して読み直す
    onfailed: (result: ApiResult<unknown>) => void;
  } = $props();

  const ids = $props.id();
  const fieldId = `${ids}-limit`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  let dialog = $state<ReturnType<typeof Dialog>>();
  let open = $state(false);
  let target = $state<{ id: string; name: string } | null>(null);
  let draft = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let input = $state<HTMLInputElement>();

  const invalidText = $derived(t('boardColumnLimitInvalid', { min: COLUMN_WIP_LIMIT_MIN, max: COLUMN_WIP_LIMIT_MAX }));

  export function show(
    trigger: HTMLElement | null,
    column: { id: string; name: string; wip_limit: number | null },
  ): void {
    target = { id: column.id, name: column.name };
    draft = column.wip_limit === null ? '' : String(column.wip_limit);
    error = null;
    saving = false;
    dialog?.show(trigger);
  }

  // 空は上限なし（null）。1〜99 の整数のほかは undefined（送らない）
  function parse(raw: string): number | null | undefined {
    const text = raw.trim();
    if (text === '') return null;
    if (!/^\d+$/.test(text)) return undefined;
    const value = Number(text);
    return value >= COLUMN_WIP_LIMIT_MIN && value <= COLUMN_WIP_LIMIT_MAX ? value : undefined;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving || target === null) return;
    const limit = parse(draft);
    if (limit === undefined) {
      error = invalidText;
      input?.focus();
      return;
    }
    const column = target;
    saving = true;
    try {
      const result = await callOperation(
        columnUpdate,
        { workspace_id: workspaceId, column_id: column.id, wip_limit: limit },
        { slug },
      );
      if (result.ok) {
        open = false;
        showToast(
          limit === null
            ? t('boardColumnLimitCleared', { name: column.name })
            : t('boardColumnLimitSaved', { name: column.name, limit }),
          'check',
        );
        onsaved();
        return;
      }
      if (result.status === 400) {
        error = invalidText;
        input?.focus();
        return;
      }
      open = false;
      onfailed(result);
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:this={dialog} bind:open dismissible={!saving} title={t('boardColumnLimitTitle', { column: t('column') })}>
  {#if target !== null}
    <form class="form" id="{ids}-form" onsubmit={submit} novalidate>
      <p>{t('boardColumnLimitText', { name: target.name, task: t('task') })}</p>
      <div class="field" class:is-invalid={error !== null}>
        <label class="field-label" for={fieldId}>{t('boardColumnLimitField')}</label>
        <input
          class="input"
          id={fieldId}
          type="text"
          inputmode="numeric"
          autocomplete="off"
          bind:this={input}
          bind:value={draft}
          oninput={() => (error = null)}
          readonly={saving}
          aria-invalid={error !== null}
          aria-describedby="{hintId}{error !== null ? ` ${errorId}` : ''}"
        />
        <p class="field-hint" id={hintId}>
          {t('boardColumnLimitHint', { min: COLUMN_WIP_LIMIT_MIN, max: COLUMN_WIP_LIMIT_MAX })}
        </p>
        {#if error !== null}<span class="field-error" id={errorId} role="alert"><Icon name="alert" />{error}</span>{/if}
      </div>
      <span class="visually-hidden" role="status">{saving ? t('boardColumnLimitSaving') : ''}</span>
    </form>
  {/if}
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={saving} onclick={() => !saving && close()}
      >{t('cancel')}</button
    >
    <button class="btn is-primary" type="submit" form="{ids}-form" aria-disabled={saving}
      >{t('boardColumnLimitSave')}</button
    >
  {/snippet}
</Dialog>
