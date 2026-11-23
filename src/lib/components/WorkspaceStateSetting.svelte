<script lang="ts">
  import { page } from '$app/state';
  import { workspaceReopen } from '../../shared/operations/workspace/index.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type { WorkspaceView } from '../workspace.ts';
  import { workspaceReopenRefusal } from '../workspace-reopen-refusal.ts';
  import WorkspaceCloseDialog from './admin/WorkspaceCloseDialog.svelte';
  import Icon from './Icon.svelte';
  import Setting from './Setting.svelte';

  let {
    slug,
    workspace,
    stateUnconfirmed,
    hasDraft,
    onrefresh,
  }: {
    slug: string;
    workspace: WorkspaceView;
    stateUnconfirmed: boolean;
    hasDraft: boolean;
    onrefresh: () => Promise<void>;
  } = $props();

  const draftHint = $props.id();

  const closed = $derived(workspace.closedAt !== null);
  let closeDialog = $state<ReturnType<typeof WorkspaceCloseDialog>>();
  let reopening = $state(false);
  let refusal = $state<string | null>(null);
  const closeBlockedByDraft = $derived(!closed && hasDraft);
  const disabled = $derived(reopening || stateUnconfirmed || closeBlockedByDraft);
  let active = false;

  $effect(() => {
    active = true;
    return () => {
      active = false;
    };
  });

  async function finishClosing(outcome: 'closed' | 'state_changed' | 'unavailable' | 'unauthenticated'): Promise<void> {
    if (outcome === 'unauthenticated') {
      window.location.assign(loginUrl(page.url));
      return;
    }
    if (outcome === 'closed') {
      showToast(t('workspaceClosed', { workspace: t('workspace') }), 'check');
    } else {
      const key = outcome === 'state_changed' ? 'workspaceStateChanged' : 'workspaceUnavailable';
      showToast(t(key, { name: workspace.name }), 'alert');
    }
    await onrefresh();
  }

  async function reopen(): Promise<void> {
    reopening = true;
    try {
      const result = await callOperation(workspaceReopen, { workspace_id: workspace.id }, { slug });
      if (!active) return;
      if (result.ok) {
        showToast(t('workspaceReopened', { workspace: t('workspace') }), 'check');
      } else if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        showToast(t('workspaceStateChanged', { name: workspace.name }), 'alert');
      } else if (result.status === 404 || result.status === 403) {
        showToast(t('workspaceUnavailable', { name: workspace.name }), 'alert');
      } else {
        refusal = workspaceReopenRefusal(result, workspace.name, 'settings');
        if (refusal === null) showToast(t('workspaceReopenFailed', { workspace: t('workspace') }), 'alert');
      }
      await onrefresh();
    } finally {
      if (active) reopening = false;
    }
  }

  function act(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (disabled) return;
    refusal = null;
    if (closed) void reopen();
    else closeDialog?.show(workspace, event.currentTarget);
  }
</script>

<Setting title={t('workspaceStateTitle', { workspace: t('workspace') })} description={t('workspaceStateDesc')}>
  {#if refusal !== null && closed}
    <div class="callout is-warn" role="alert">
      <Icon name="alert" /><span class="wrap-anywhere">{refusal}</span>
    </div>
  {/if}
  {#if closeBlockedByDraft}<p class="field-hint" id={draftHint}>{t('workspaceCloseDraft')}</p>{/if}
  <div class="form-actions">
    <button
      id="workspace-state"
      class="btn"
      type="button"
      aria-disabled={disabled}
      aria-describedby={closeBlockedByDraft ? draftHint : undefined}
      aria-label={t(closed ? 'workspaceReopenLabel' : 'workspaceCloseLabel', { name: workspace.name })}
      onclick={act}
    >
      {t(closed ? 'workspaceReopenAction' : 'workspaceCloseAction')}
    </button>
    <span class="visually-hidden" role="status">
      {reopening ? t('workspaceReopening') : ''}
    </span>
  </div>
</Setting>

<WorkspaceCloseDialog bind:this={closeDialog} {slug} onfinish={(outcome) => void finishClosing(outcome)} />
