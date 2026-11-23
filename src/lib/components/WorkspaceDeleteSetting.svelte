<script lang="ts">
  import { goto, refreshAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { workspaceDelete } from '../../shared/operations/workspace/index.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { isComposingKey } from '../shortcut-keys.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type { WorkspaceView } from '../workspace.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import Setting from './Setting.svelte';

  let { slug, workspace, stateUnconfirmed }: { slug: string; workspace: WorkspaceView; stateUnconfirmed: boolean } =
    $props();

  const formId = $props.id();
  const nameId = `${formId}-name`;
  const hintId = `${formId}-hint`;
  const mismatchId = `${formId}-mismatch`;
  let dialog = $state<ReturnType<typeof Dialog>>();
  let open = $state(false);
  let confirmation = $state('');
  let composing = $state(false);
  let nameBlurred = $state(false);
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let mounted = true;
  $effect(() => () => {
    mounted = false;
  });

  const closed = $derived(workspace.closedAt !== null);
  const nameMatches = $derived(confirmation === workspace.name);
  const nameMismatch = $derived(
    !composing && confirmation !== '' && !nameMatches && (nameBlurred || !workspace.name.startsWith(confirmation)),
  );
  const canConfirm = $derived(closed && !stateUnconfirmed && nameMatches && !composing);
  const words = $derived({ workspace: t('workspace') });

  function show(trigger: HTMLElement): void {
    confirmation = '';
    composing = false;
    nameBlurred = false;
    submitError = null;
    dialog?.show(trigger);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canConfirm || submitting) return;
    const targetSlug = slug;
    const targetId = workspace.id;
    submitting = true;
    submitError = null;
    try {
      const result = await callOperation(
        workspaceDelete,
        { workspace_id: targetId, confirm_name: confirmation },
        { slug: targetSlug },
      );
      if (!mounted || slug !== targetSlug || workspace.id !== targetId) {
        showToast(t(result.ok ? 'workspaceDeleted' : 'workspaceDeleteFailed', words), result.ok ? 'check' : 'alert');
        if (result.ok) void refreshAll().catch(() => undefined);
        return;
      }
      if (result.ok) {
        open = false;
        showToast(t('workspaceDeleted', words), 'check');
        await goto(resolve('/[slug]', { slug: targetSlug }), { refreshAll: true, replace: true }).catch(() =>
          location.replace(resolve('/[slug]', { slug: targetSlug })),
        );
        return;
      }
      if (isUnauthenticated(result)) {
        location.assign(loginUrl(page.url));
        return;
      }
      const details = result.error?.details;
      const reason =
        result.error?.code === 'conflict' && typeof details === 'object' && details !== null && 'reason' in details
          ? details.reason
          : null;
      if (reason === 'workspace_name_mismatch') {
        confirmation = '';
        submitError = t('workspaceDeleteNameChanged', words);
        void refreshAll().catch(() => undefined);
      } else if (reason === 'workspace_not_closed' || result.status === 403 || result.status === 404) {
        open = false;
        showToast(
          t(reason === 'workspace_not_closed' ? 'workspaceDeleteNeedsClosed' : 'workspaceDeleteUnavailable', words),
          'alert',
        );
        void refreshAll().catch(() => undefined);
      } else {
        submitError = t('workspaceDeleteFailed', words);
      }
    } finally {
      if (mounted) submitting = false;
    }
  }
</script>

<Setting title={t('workspaceDeleteTitle', words)} description={t('workspaceDeleteDescription', words)}>
  {#if closed}
    <div class="form-actions">
      <button
        class="btn is-danger"
        type="button"
        disabled={stateUnconfirmed}
        onclick={(event) => show(event.currentTarget)}
      >
        {t('workspaceDeleteAction')}
      </button>
    </div>
  {:else}
    <p class="field-hint">
      {t('workspaceDeleteNeedsClosed', words)}
      <a href="#workspace-state">{t('workspaceDeleteCloseLink')}</a>
    </p>
  {/if}
</Setting>

<Dialog
  bind:this={dialog}
  bind:open
  danger
  dismissible={!submitting}
  title={t('workspaceDeleteConfirm', { name: workspace.name })}
>
  <p>{t('workspaceDeleteWarning', words)}</p>
  <p>{t('workspaceDeleteStorageWarning', words)}</p>
  <form id={formId} onsubmit={submit}>
    <div class="field" class:is-invalid={nameMismatch}>
      <label class="field-label" for={nameId}>{t('workspaceDeleteName', words)}</label>
      <input
        class="input"
        id={nameId}
        aria-describedby={nameMismatch ? `${hintId} ${mismatchId}` : hintId}
        aria-invalid={nameMismatch}
        autocomplete="off"
        spellcheck="false"
        bind:value={confirmation}
        readonly={submitting}
        oncompositionstart={() => (composing = true)}
        oncompositionend={() => (composing = false)}
        onfocus={() => (nameBlurred = false)}
        onblur={() => (nameBlurred = true)}
        onkeydown={(event) => {
          if (event.key === 'Enter' && (composing || isComposingKey(event))) event.preventDefault();
        }}
      />
      <span class="field-hint wrap-anywhere" id={hintId}>{t('workspaceDeleteNameHint', { name: workspace.name })}</span>
      {#if nameMismatch}
        <span class="field-error" id={mismatchId}><Icon name="alert" />{t('workspaceDeleteNameMismatch', words)}</span>
      {/if}
    </div>
  </form>
  {#if !closed}
    <div class="callout is-warn" role="alert">
      <Icon name="alert" /><span>{t('workspaceDeleteNeedsClosed', words)}</span>
    </div>
  {:else if submitError !== null}
    <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
  {/if}
  {#snippet footer(close)}
    <span class="field-hint" class:visually-hidden={!submitting} role="status">
      {submitting ? t('workspaceDeleting') : ''}
    </span>
    <button class="btn is-primary" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-danger"
      type="submit"
      form={formId}
      disabled={!canConfirm}
      aria-disabled={submitting || !canConfirm}
    >
      {t('workspaceDeleteAction')}
    </button>
  {/snippet}
</Dialog>
