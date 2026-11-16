<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { page } from '$app/state';
  import { workspaceInfo, workspaceSprintNamingUpdate } from '../../shared/operations/workspace/index.ts';
  import {
    SPRINT_NAME_MAX_LENGTH,
    expandSprintName,
    normalizeSprintName,
    sprintNameTemplateProblem,
  } from '../../shared/sprint.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { SprintNumberDraft } from '../sprint-number-draft.svelte.ts';
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
    refreshFailed = false,
    onretry,
    retrying = false,
    retryFailed = false,
  }: {
    slug: string;
    workspaceId: string;
    value: { start_on: string; sprint_name_template: string | null; sprint_number_next: number };
    canWrite: boolean;
    // 保存した。設定の一覧と命名ルールの初期値を読み直す
    onsaved: () => Promise<void>;
    // ワークスペースが閉じていたか、見つからない、操作できない。枠ごと読み直す
    onstale: () => void;
    ondirty: (dirty: boolean) => void;
    refreshFailed?: boolean;
    onretry: () => Promise<void>;
    retrying?: boolean;
    retryFailed?: boolean;
  } = $props();

  const variableKeys = [
    'sprintNamingVariableN',
    'sprintNamingVariableYyyy',
    'sprintNamingVariableYy',
    'sprintNamingVariableMm',
    'sprintNamingVariableM',
    'sprintNamingVariableDd',
    'sprintNamingVariableD',
    'sprintNamingVariableW',
  ] as const;
  const ids = $props.id();
  const fieldId = `${ids}-field`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  // 欄の文と、欄が今もとにしている保存した値。読み直した値（value）が替わったら、欄を変えていなければ合わせる
  let draft = $state(untrack(() => value.sprint_name_template ?? ''));
  const numberDraft = new SprintNumberDraft(untrack(() => value.sprint_number_next));
  let numberNotice = $state('');
  let base = $state.raw(untrack(() => value));
  const valueKey = (current: typeof value) =>
    JSON.stringify([current.start_on, current.sprint_name_template, current.sprint_number_next]);
  let seen = untrack(() => valueKey(value));
  $effect.pre(() => {
    const next = value;
    const key = valueKey(next);
    if (key === seen) return;
    seen = key;
    untrack(() => {
      if (normalizeSprintName(draft) === base.sprint_name_template) draft = next.sprint_name_template ?? '';
      if (numberDraft.receive(next.sprint_number_next))
        numberNotice = t('sprintNamingNumberRefreshed', { number: next.sprint_number_next });
      base = next;
    });
  });

  let sending = $state(false);
  let error = $state<{ text: string; field: 'template' | 'number' | null } | null>(null);
  let status = $state('');
  let field = $state<HTMLInputElement>();
  let numberField = $state<HTMLInputElement>();

  const changed = $derived(normalizeSprintName(draft) !== base.sprint_name_template || numberDraft.edited);
  const numberProblem = $derived(
    Number.isSafeInteger(numberDraft.value) && numberDraft.value !== null && numberDraft.value >= 1
      ? null
      : t('sprintNamingNumberInvalid'),
  );
  const templateProblem = $derived(problemText(normalizeSprintName(draft)));
  const example = $derived(expandSprintName(normalizeSprintName(draft), value.start_on, numberDraft.value ?? 0));
  const expansionFailed = $derived(
    templateProblem === null && numberProblem === null && normalizeSprintName(draft) !== null && example === null,
  );

  $effect(() => {
    ondirty(canWrite && (changed || sending));
  });
  $effect(() => () => ondirty(false));

  function problemText(normalized: string | null): string | null {
    const problem = sprintNameTemplateProblem(normalized);
    if (problem === 'too_long') return t('sprintNamingTooLong', { max: SPRINT_NAME_MAX_LENGTH });
    if (problem === 'invalid_character') return t('sprintNamingInvalidCharacter');
    if (problem === 'unknown_variable') return t('sprintNamingUnknown');
    return null;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending || !canWrite) return;
    const normalized = normalizeSprintName(draft);
    status = '';
    if (!changed) {
      error = null;
      await tick();
      status = t('sprintNamingUnchanged');
      return;
    }
    const problem = problemText(normalized);
    if (problem !== null) {
      error = { text: problem, field: 'template' };
      field?.focus();
      return;
    }
    if (!Number.isSafeInteger(numberDraft.value) || numberDraft.value === null || numberDraft.value < 1) {
      error = { text: t('sprintNamingNumberInvalid'), field: 'number' };
      numberField?.focus();
      return;
    }
    error = null;
    sending = true;
    status = t('sprintNamingSaving');
    try {
      let nextNumber = numberDraft.value;
      if (!numberDraft.edited) {
        const current = await callOperation(workspaceInfo, { workspace_id: workspaceId }, { slug });
        if (!current.ok) {
          if (isUnauthenticated(current)) window.location.assign(loginUrl(page.url));
          else if (current.status === 403 || current.status === 404) {
            error = { text: t('sprintNamingUnavailable'), field: null };
            onstale();
          } else error = { text: t('sprintNamingFailed'), field: null };
          return;
        }
        nextNumber = current.data.sprint_number_next;
      }
      const result = await callOperation(
        workspaceSprintNamingUpdate,
        { workspace_id: workspaceId, sprint_name_template: draft, sprint_number_next: nextNumber },
        { slug },
      );
      if (result.ok) {
        const saved = result.data;
        base = { ...value, ...saved };
        draft = saved.sprint_name_template ?? '';
        if (numberDraft.value !== saved.sprint_number_next)
          numberNotice = t('sprintNamingNumberRefreshed', { number: saved.sprint_number_next });
        numberDraft.saved(saved.sprint_number_next);
        // 設定の読み直しを待つ間に「保存しています」を残さない
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
        error = { text: t('sprintNamingUnavailable'), field: null };
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
  {#if refreshFailed}
    <p class="field-error" role="alert"><Icon name="alert" />{t('sprintNamingLoadFailed')}</p>
    <button class="btn is-sm" type="button" aria-disabled={retrying} onclick={() => void onretry()}>{t('retry')}</button
    >
    <span class="field-hint" role="status">{retrying ? t('retrying') : retryFailed ? t('retryFailed') : ''}</span>
  {/if}
  {#if canWrite}
    <form class="field" onsubmit={save} novalidate>
      <div class="field" class:is-invalid={templateProblem !== null}>
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
          aria-invalid={templateProblem !== null}
          aria-describedby={[
            hintId,
            `${hintId}-variables`,
            templateProblem === null && numberProblem === null && !expansionFailed ? `${hintId}-example` : null,
            templateProblem !== null ? `${errorId}-template` : null,
            expansionFailed ? `${errorId}-expansion` : null,
          ]
            .filter(Boolean)
            .join(' ')}
        />
        <p class="field-hint" id={hintId}>{t('sprintNamingHint')}</p>
        {#if templateProblem !== null}
          <span class="field-error" id="{errorId}-template"><Icon name="alert" />{templateProblem}</span>
        {/if}
        {#if expansionFailed}
          <p class="callout is-warn" id="{errorId}-expansion" role="note">
            <Icon name="alert" />{t('sprintNamingExpansionWarning', { max: SPRINT_NAME_MAX_LENGTH })}
          </p>
        {/if}
      </div>
      <div class="field" class:is-invalid={numberProblem !== null}>
        <label class="field-label" for="{fieldId}-number">{t('sprintNamingNumber')}</label>
        <input
          class="input"
          id="{fieldId}-number"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          bind:this={numberField}
          bind:value={numberDraft.value}
          readonly={sending}
          oninput={() => {
            numberDraft.input();
            numberNotice = '';
            error = null;
            status = '';
          }}
          aria-invalid={numberProblem !== null}
          aria-describedby={numberProblem !== null ? `${errorId}-number` : undefined}
        />
        {#if numberProblem !== null}
          <span class="field-error" id="{errorId}-number"><Icon name="alert" />{numberProblem}</span>
        {/if}
        {#if numberNotice}<p class="field-hint">{numberNotice}</p>{/if}
      </div>
      <div class="doc-box" id="{hintId}-variables">
        <ul>
          {#each variableKeys as key (key)}<li>{t(key)}</li>{/each}
        </ul>
      </div>
      {#if templateProblem === null && numberProblem === null && !expansionFailed}
        <p class="field-hint" id="{hintId}-example">
          {t('sprintNamingExample', { date: value.start_on, name: example ?? t('sprintNamingEmpty') })}
        </p>
      {/if}
      {#if error !== null && error.field === null}
        <span class="field-error" id={errorId} role="alert"><Icon name="alert" />{error.text}</span>
      {/if}
      <div class="form-actions">
        <button class="btn is-primary" type="submit" aria-disabled={sending}>{t('sprintNamingSave')}</button>
        <span class="field-hint" role="status">{status}</span>
      </div>
    </form>
  {:else}
    <div class="field">
      <span class="field-label" id="{fieldId}-readonly-label">{t('sprintNamingTemplate')}</span>
      <div class="doc-box is-plain" role="note" aria-labelledby="{fieldId}-readonly-label">
        {value.sprint_name_template ?? t('sprintNamingEmpty')}
      </div>
    </div>
    <div class="field">
      <span class="field-label" id="{fieldId}-readonly-number-label">{t('sprintNamingNumber')}</span>
      <div class="doc-box is-plain" role="note" aria-labelledby="{fieldId}-readonly-number-label">
        {value.sprint_number_next}
      </div>
    </div>
  {/if}
</Setting>
