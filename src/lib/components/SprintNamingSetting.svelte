<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { workspaceSprintNamingUpdate } from '../../shared/operations/workspace/index.ts';
  import { expandSprintName, normalizeSprintName, sprintNameTemplateProblem } from '../../shared/sprint.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import Setting from './Setting.svelte';

  let {
    slug,
    workspaceId,
    value,
    canWrite,
    onsaved,
    onstale,
    ondirty,
  }: {
    slug: string;
    workspaceId: string;
    value: { start_on: string; sprint_name_template: string | null; sprint_number_next: number };
    canWrite: boolean;
    // 保存した。枠を読み直す
    onsaved: () => Promise<void>;
    // ワークスペースが閉じていたか、見つからない、操作できない。枠ごと読み直す
    onstale: () => void;
    ondirty: (dirty: boolean) => void;
  } = $props();

  const ids = $props.id();
  const fieldId = `${ids}-field`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  // 欄の文と、欄が今もとにしている保存した値。読み直した値（value）が替わったら、欄を変えていなければ合わせる
  let draft = $state(untrack(() => value.sprint_name_template ?? ''));
  let number = $state<number | null>(untrack(() => value.sprint_number_next));
  let base = $state(untrack(() => value));
  let seen = untrack(() => value);
  $effect.pre(() => {
    const next = value;
    if (next === seen) return;
    seen = next;
    untrack(() => {
      if (!changed) {
        draft = next.sprint_name_template ?? '';
        number = next.sprint_number_next;
      }
      base = next;
    });
  });

  let sending = $state(false);
  let error = $state<{ text: string; field: 'template' | 'number' | null } | null>(null);
  let status = $state('');
  let field = $state<HTMLInputElement>();
  let numberField = $state<HTMLInputElement>();

  const changed = $derived(
    normalizeSprintName(draft) !== base.sprint_name_template || number !== base.sprint_number_next,
  );
  const numberProblem = $derived(
    Number.isSafeInteger(number) && number !== null && number >= 1 ? null : t('sprintNamingNumberInvalid'),
  );
  const example = $derived(expandSprintName(normalizeSprintName(draft), value.start_on, number ?? 0));

  $effect(() => {
    ondirty(canWrite && (changed || sending));
  });

  function problemText(normalized: string | null): string | null {
    const problem = sprintNameTemplateProblem(normalized);
    if (problem === 'too_long') return t('sprintNamingTooLong');
    if (problem === 'invalid_character') return t('sprintNamingInvalidCharacter');
    if (problem === 'unknown_variable') return t('sprintNamingUnknown');
    return null;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending || !canWrite) return;
    const normalized = normalizeSprintName(draft);
    status = '';
    if (!changed) return;
    const problem = problemText(normalized);
    if (problem !== null) {
      error = { text: problem, field: 'template' };
      field?.focus();
      return;
    }
    if (!Number.isSafeInteger(number) || number === null || number < 1) {
      error = { text: t('sprintNamingNumberInvalid'), field: 'number' };
      numberField?.focus();
      return;
    }
    error = null;
    sending = true;
    status = t('sprintNamingSaving');
    try {
      const result = await callOperation(
        workspaceSprintNamingUpdate,
        { workspace_id: workspaceId, sprint_name_template: draft, sprint_number_next: number },
        { slug },
      );
      if (result.ok) {
        const saved = result.data;
        base = { ...value, ...saved };
        draft = saved.sprint_name_template ?? '';
        number = saved.sprint_number_next;
        // 枠の読み直しを待つ間に「保存しています」を残さない
        sending = false;
        status = '';
        showToast(t('sprintNamingSaved', { sprint: t('sprint') }), 'check');
        await onsaved();
        return;
      }
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        onstale();
        return;
      }
      if (result.status === 403 || result.status === 404) {
        error = { text: t('sprintNamingFailed'), field: null };
        onstale();
        return;
      }
      if (result.status === 409) {
        error = { text: t('sprintNamingFailed'), field: null };
        status = '';
        await onsaved();
        return;
      }
      // 400 は画面の検査を通った後なので、理由を決めつけず、ほかの失敗と同じ文にする
      error = { text: t('sprintNamingFailed'), field: null };
    } finally {
      sending = false;
      if (status === t('sprintNamingSaving')) status = '';
    }
  }
</script>

<Setting
  title={t('sprintNamingTitle', { sprint: t('sprint') })}
  description={t('sprintNamingDesc', { sprint: t('sprint') })}
>
  {#if canWrite}
    <form class="field" onsubmit={save} novalidate>
      <div class="field" class:is-invalid={error?.field === 'template'}>
        <label class="field-label" for={fieldId}>{t('sprintNamingTemplate')}</label>
        <input
          class="input"
          id={fieldId}
          bind:this={field}
          bind:value={draft}
          readonly={sending}
          oninput={() => {
            error = null;
            status = '';
          }}
          aria-invalid={error?.field === 'template'}
          aria-describedby="{hintId} {hintId}-variables {hintId}-example{error?.field === 'template'
            ? ` ${errorId}`
            : ''}"
        />
        <p class="field-hint" id={hintId}>{t('sprintNamingHint')}</p>
      </div>
      <div class="field" class:is-invalid={error?.field === 'number'}>
        <label class="field-label" for="{fieldId}-number">{t('sprintNamingNumber')}</label>
        <input
          class="input"
          id="{fieldId}-number"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          bind:this={numberField}
          bind:value={number}
          readonly={sending}
          oninput={() => {
            error = null;
            status = '';
          }}
          aria-invalid={error?.field === 'number'}
          aria-describedby={error?.field === 'number' ? errorId : undefined}
        />
      </div>
      <p class="field-hint" id="{hintId}-variables">{t('sprintNamingVariables')}</p>
      <p class="field-hint" id="{hintId}-example" role="status">
        {t('sprintNamingExample', {
          date: value.start_on,
          name:
            problemText(normalizeSprintName(draft)) ??
            numberProblem ??
            example ??
            (normalizeSprintName(draft) === null ? t('sprintNamingEmpty') : t('sprintNamingExpansionFailed')),
        })}
      </p>
      {#if error !== null}
        <span class="field-error" id={errorId} role="alert"><Icon name="alert" />{error.text}</span>
      {/if}
      <div class="form-actions">
        <button class="btn is-primary" type="submit" aria-disabled={sending || !changed}>{t('sprintNamingSave')}</button
        >
        <span class="field-hint" role="status">{status}</span>
      </div>
    </form>
  {:else}
    <p>{value.sprint_name_template ?? t('sprintNamingEmpty')}</p>
    <p>{t('sprintNamingNumber')}: {value.sprint_number_next}</p>
  {/if}
</Setting>
