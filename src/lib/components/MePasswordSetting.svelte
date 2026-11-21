<script lang="ts">
  import { page } from '$app/state';
  import { normalizePassword } from '../../shared/password.ts';
  import { passwordChange } from '../../shared/operations/session/password.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Section from './Section.svelte';

  const id = $props.id();
  let current = $state('');
  let next = $state('');
  let confirmation = $state('');
  let sending = $state(false);
  let changed = $state(false);
  let error = $state<DictionaryKey | null>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    changed = false;
    error = null;

    const normalized = normalizePassword(next);
    if (normalized === undefined) {
      error = 'mePasswordInvalid';
      return;
    }
    if (normalized !== normalizePassword(confirmation)) {
      error = 'mePasswordMismatch';
      return;
    }

    sending = true;
    try {
      const result = await callOperation(passwordChange, { current_password: current, new_password: normalized });
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (!result.ok) {
        if (result.error?.code === 'invalid_credentials') {
          current = '';
          error = 'mePasswordIncorrect';
        } else {
          error = result.error?.code === 'rate_limited' ? 'mePasswordRateLimited' : 'mePasswordFailed';
        }
        return;
      }
      current = '';
      next = '';
      confirmation = '';
      changed = true;
    } finally {
      sending = false;
    }
  }
</script>

<Section id="{id}-title" title={t('mePasswordChange')}>
  <form class="form" method="post" onsubmit={submit}>
    <p class="action-note">{t('mePasswordSessionNote')}</p>
    <div class="field">
      <label class="field-label" for="{id}-current">{t('mePasswordCurrent')}</label>
      <input
        class="input"
        id="{id}-current"
        type="password"
        autocomplete="current-password"
        aria-invalid={error === 'mePasswordIncorrect' ? true : undefined}
        aria-describedby={error === 'mePasswordIncorrect' ? `${id}-error` : undefined}
        bind:value={current}
        readonly={sending}
        required
      />
    </div>
    <div class="field">
      <label class="field-label" for="{id}-new">{t('mePasswordNew')}</label>
      <input
        class="input"
        id="{id}-new"
        type="password"
        autocomplete="new-password"
        aria-invalid={error === 'mePasswordInvalid' ? true : undefined}
        aria-describedby={error === 'mePasswordInvalid' ? `${id}-error` : `${id}-hint`}
        bind:value={next}
        readonly={sending}
        required
      />
      <p class="field-hint" id="{id}-hint">{t('mePasswordHint')}</p>
    </div>
    <div class="field">
      <label class="field-label" for="{id}-confirm">{t('mePasswordConfirm')}</label>
      <input
        class="input"
        id="{id}-confirm"
        type="password"
        autocomplete="new-password"
        aria-invalid={error === 'mePasswordMismatch' ? true : undefined}
        aria-describedby={error === 'mePasswordMismatch' ? `${id}-error` : undefined}
        bind:value={confirmation}
        readonly={sending}
        required
      />
    </div>
    <div class="form-actions">
      <button type="submit" class="btn is-primary" aria-disabled={sending}>
        {t(sending ? 'mePasswordSaving' : 'mePasswordChange')}
      </button>
    </div>
    <div role="alert" id="{id}-error">
      {#if error}<span class="field-error">{t(error)}</span>{/if}
    </div>
    <div role="status">{changed ? t('mePasswordChanged') : ''}</div>
  </form>
</Section>
