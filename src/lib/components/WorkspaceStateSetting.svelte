<script lang="ts">
  import { invalidateAll } from '$app/navigation';
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
    stale,
    hasDraft,
    onstateunconfirmed,
  }: {
    slug: string;
    workspace: WorkspaceView;
    stale: boolean;
    hasDraft: boolean;
    onstateunconfirmed: (unconfirmed: boolean) => void;
  } = $props();

  const draftHint = $props.id();

  const closed = $derived(workspace.closedAt !== null);
  let closeDialog = $state<ReturnType<typeof WorkspaceCloseDialog>>();
  let stateButton = $state<HTMLButtonElement>();
  let pending = $state<'reopening' | 'refreshing' | null>(null);
  let refusal = $state<string | null>(null);
  let refreshFailed = $state(false);
  const needsRefresh = $derived(stale || refreshFailed);
  const closeBlockedByDraft = $derived(!closed && hasDraft);
  const disabled = $derived(pending !== null || needsRefresh || closeBlockedByDraft);
  let active = false;

  $effect(() => {
    active = true;
    return () => {
      active = false;
      onstateunconfirmed(false);
    };
  });

  async function refresh(): Promise<void> {
    // 枠の帯・設定の値に加えて、組織の枠が持つ切り替え一覧も読み直す
    pending = 'refreshing';
    onstateunconfirmed(true);
    try {
      await invalidateAll();
      if (active) refreshFailed = false;
    } catch {
      if (active) refreshFailed = true;
    } finally {
      if (active) {
        pending = null;
        onstateunconfirmed(refreshFailed);
      }
    }
  }

  async function retry(): Promise<void> {
    if (pending !== null) return;
    await refresh();
    if (active && !needsRefresh) stateButton?.focus();
  }

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
    await refresh();
  }

  async function reopen(): Promise<void> {
    pending = 'reopening';
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
        refusal = workspaceReopenRefusal(result, workspace.name);
        if (refusal === null) showToast(t('workspaceReopenFailed', { workspace: t('workspace') }), 'alert');
      }
      await refresh();
    } finally {
      if (active) pending = null;
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
  {#if needsRefresh}
    <div class="callout is-warn">
      <Icon name="alert" /><span role="alert">{t('workspaceStateRefreshFailed')}</span>
      <div class="callout-actions">
        <button class="btn is-sm" type="button" aria-disabled={pending !== null} onclick={retry}>
          {t('retry')}
        </button>
      </div>
    </div>
  {:else if refusal !== null && closed}
    <div class="callout is-warn" role="alert">
      <Icon name="alert" /><span class="wrap-anywhere">{refusal}</span>
    </div>
  {/if}
  {#if closeBlockedByDraft}<p class="field-hint" id={draftHint}>{t('workspaceCloseDraft')}</p>{/if}
  <div class="form-actions">
    <button
      bind:this={stateButton}
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
      {pending === 'reopening' ? t('workspaceReopening') : pending === 'refreshing' ? t('retrying') : ''}
    </span>
  </div>
</Setting>

<WorkspaceCloseDialog bind:this={closeDialog} {slug} onfinish={(outcome) => void finishClosing(outcome)} />
