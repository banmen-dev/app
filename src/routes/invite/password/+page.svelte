<script module lang="ts">
  // URL の置き換えに伴う画面の作り直しをまたいで、同じ文書の間だけ秘密を持つ。
  let pendingToken = '';
</script>

<script lang="ts">
  import { beforeNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import Gate from '../../../lib/components/Gate.svelte';
  import GateSheet from '../../../lib/components/GateSheet.svelte';
  import Icon from '../../../lib/components/Icon.svelte';
  import LegalLinks from '../../../lib/components/LegalLinks.svelte';
  import { PASSWORD_LOGIN_TIMEOUT_MS } from '../../../lib/password-login.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import { CLAIM_TOKEN_PATTERN, PASSWORD_INVITE_PATH } from '../../../shared/claim-token.ts';
  import { normalizePassword } from '../../../shared/password.ts';
  import { PASSWORD_LOGIN_ENABLED } from '../../../shared/password-login-enabled.ts';
  import { safeReturnTo } from '../../../shared/return-to.ts';
  import { shortTextProblem } from '../../../shared/text-rules.ts';
  import type { DictionaryKey } from '../../../shared/vocabulary.ts';

  type Nomination = { email: string; existing_account: boolean };

  let nomination = $state<Nomination>();
  let loading = $state(true);
  let submitting = $state(false);
  let error = $state<DictionaryKey>();
  let displayName = $state('');
  let password = $state('');
  let confirmation = $state('');

  async function request(action: 'inspect' | 'accept', body: object): Promise<Response> {
    return fetch('/api/auth/password/nomination/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Origin の検査付きの POST。Referer は同じオリジンのルートだけを送る。
      referrer: location.origin + '/',
      referrerPolicy: 'same-origin',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PASSWORD_LOGIN_TIMEOUT_MS),
    });
  }

  function responseMessage(status: number): DictionaryKey {
    if (status === 404) return 'passwordNominationUnusable';
    if (status === 429) return 'passwordNominationTooMany';
    if (status === 401) return 'mePasswordIncorrect';
    if (status === 400) return 'passwordNominationInvalid';
    return 'passwordNominationUnavailable';
  }

  async function inspect(token: string): Promise<void> {
    try {
      const response = await request('inspect', { claim_token: token });
      if (pendingToken !== token) return;
      if (!response.ok) {
        if (response.status === 404) invalidate();
        else error = response.status === 429 ? 'passwordNominationTooMany' : 'passwordNominationUnavailable';
        return;
      }

      const body: unknown = await response.json();
      if (pendingToken !== token) return;
      if (
        typeof body !== 'object' ||
        body === null ||
        !('email' in body) ||
        typeof body.email !== 'string' ||
        !('existing_account' in body) ||
        typeof body.existing_account !== 'boolean'
      ) {
        error = 'passwordNominationUnavailable';
        return;
      }
      nomination = { email: body.email, existing_account: body.existing_account };
    } catch {
      if (pendingToken === token) error = 'passwordNominationUnavailable';
    }
  }

  async function loadNomination(): Promise<void> {
    const hasFragment = location.href.includes('#');
    if (hasFragment) {
      clear();
      pendingToken = location.hash.slice(1);
    }
    const token = pendingToken;
    loading = true;
    error = undefined;
    try {
      if (hasFragment) await goto(resolve(PASSWORD_INVITE_PATH), { replace: true });
      if (pendingToken !== token) return;
      if (!PASSWORD_LOGIN_ENABLED || location.href.includes('#') || !CLAIM_TOKEN_PATTERN.test(token)) {
        invalidate();
        return;
      }
      await inspect(token);
    } finally {
      if (pendingToken === token) loading = false;
    }
  }

  onMount(() => {
    void loadNomination();
  });

  // 同じ画面で新しい指名 URL を開くと、ブラウザーは文書を読み直さずフラグメントだけを変える。
  function readNewFragment(): void {
    if (location.href.includes('#')) void loadNomination();
  }

  function clear(): void {
    pendingToken = '';
    nomination = undefined;
    password = '';
    confirmation = '';
    displayName = '';
    loading = false;
    submitting = false;
  }

  function invalidate(): void {
    clear();
    error = 'passwordNominationUnusable';
  }

  beforeNavigate(({ to }) => {
    if (to?.route.id !== PASSWORD_INVITE_PATH) clear();
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || nomination === undefined || pendingToken === '') return;

    const token = pendingToken;
    const existing = nomination.existing_account;
    const input = { claim_token: token, password };
    if (!existing) {
      const normalized = normalizePassword(password);
      const name = displayName.trim();
      if (!name.isWellFormed() || shortTextProblem(name, 100) !== null) {
        error = 'passwordNominationNameInvalid';
        return;
      }
      if (normalized === undefined) {
        error = 'passwordNominationPasswordInvalid';
        return;
      }
      if (normalized !== normalizePassword(confirmation)) {
        error = 'passwordNominationMismatch';
        return;
      }
    }

    error = undefined;
    submitting = true;
    try {
      const response = await request(
        'accept',
        existing ? input : { ...input, password_confirmation: confirmation, display_name: displayName },
      );
      if (pendingToken !== token) return;
      if (!response.ok) {
        error = responseMessage(response.status);
        if (response.status === 404) invalidate();
        if (response.status === 401 && !existing) {
          await inspect(token);
          if (pendingToken === token && nomination?.existing_account) {
            displayName = '';
            error = 'passwordNominationAccountCreated';
          }
        }
        return;
      }

      const body: unknown = await response.json();
      if (pendingToken !== token) return;
      const returnTo =
        typeof body === 'object' && body !== null && 'return_to' in body ? safeReturnTo(body.return_to) : undefined;
      if (returnTo === undefined) {
        error = 'passwordNominationUnavailable';
        return;
      }
      location.assign(returnTo);
      pendingToken = '';
      password = '';
      confirmation = '';
    } catch {
      if (pendingToken === token) error = 'passwordNominationUnavailable';
    } finally {
      if (pendingToken === token) {
        password = '';
        confirmation = '';
        submitting = false;
      }
    }
  }
</script>

<svelte:window onhashchange={readNewFragment} onpagehide={clear} />

<svelte:head>
  <title>{t('pageTitle', { page: t('passwordNominationTitle'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('passwordNominationTitle')}>
    <div class={loading ? 'gate-note' : 'visually-hidden'} role="status">
      {submitting ? t('passwordNominationSubmitting') : loading ? t('passwordNominationLoading') : ''}
    </div>
    {#if error !== undefined}
      <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{t(error)}</span></div>
    {/if}
    {#if nomination !== undefined}
      <form class="gate-group" onsubmit={submit}>
        <label class="field">
          <span class="field-label">{t('loginEmailLabel')}</span>
          <input class="input" name="username" type="email" value={nomination.email} autocomplete="username" readonly />
        </label>
        {#if !nomination.existing_account}
          <label class="field">
            <span class="field-label">{t('operatorNameLabel')}</span>
            <input class="input" name="display-name" autocomplete="name" bind:value={displayName} required />
          </label>
        {/if}
        <div class="field">
          <label class="field-label" for="nomination-password"
            >{t(nomination.existing_account ? 'mePasswordCurrent' : 'loginPasswordLabel')}</label
          >
          <input
            class="input"
            id="nomination-password"
            name="password"
            type="password"
            autocomplete={nomination.existing_account ? 'current-password' : 'new-password'}
            aria-describedby={nomination.existing_account ? undefined : 'nomination-password-hint'}
            bind:value={password}
            required
          />
          {#if !nomination.existing_account}
            <span class="field-hint" id="nomination-password-hint">{t('mePasswordHint')}</span>
          {/if}
        </div>
        {#if !nomination.existing_account}
          <label class="field">
            <span class="field-label">{t('passwordNominationConfirmation')}</span>
            <input class="input" type="password" autocomplete="new-password" bind:value={confirmation} required />
          </label>
        {/if}
        <button type="submit" class="btn is-wide is-primary" aria-disabled={submitting ? 'true' : undefined}>
          {t(
            submitting
              ? 'passwordNominationSubmitting'
              : nomination.existing_account
                ? 'passwordNominationConfirm'
                : 'passwordNominationRegister',
          )}
        </button>
      </form>
    {/if}
    {#if error === 'passwordNominationUnusable' || error === 'passwordNominationUnavailable' || error === 'passwordNominationTooMany'}
      <div class="form-actions">
        {#if nomination === undefined && error !== 'passwordNominationUnusable'}
          <button class="btn is-sm" type="button" onclick={loadNomination}>{t('passwordNominationRetry')}</button>
        {/if}
        <a class="btn is-sm is-quiet" href={resolve('/login')}>{t('inviteToLogin')}</a>
      </div>
    {/if}
    <LegalLinks newTab />
  </GateSheet>
</Gate>
