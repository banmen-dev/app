<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { meAvatarDelete, organizationInfo } from '../../shared/operations/organization/index.ts';
  import { AVATAR_MAX_BYTES, AVATAR_MAX_PIXELS } from '../../shared/operations/organization/me-avatar.ts';
  import { operationPath } from '../../shared/operations/define.ts';
  import { callOperation } from '../api.ts';
  import { AVATAR_SOURCE_MAX_BYTES, avatarImageTypes, isAvatarSource } from '../image-crop.ts';
  import { uploadAvatar } from '../avatar-upload.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Dialog from './Dialog.svelte';
  import ImageCrop from './ImageCrop.svelte';
  import Setting from './Setting.svelte';
  import Icon from './Icon.svelte';

  let { slug, userId, name, image }: { slug: string; userId: string; name: string; image: string | null } = $props();
  let picker: HTMLInputElement;
  let chooseButton: HTMLButtonElement;
  let dialog: Dialog;
  let cropper = $state<ImageCrop>();
  let bitmap = $state<ImageBitmap | null>(null);
  let open = $state(false);
  let busy = $state(false);
  let reading = $state(false);
  let error = $state<string | null>(null);
  let cropError = $state<string | null>(null);
  let version = 0;
  let alive = true;
  const uploaded = $derived(image?.startsWith(`/api/${encodeURIComponent(slug)}/user-avatar/`) ?? false);
  function release(): void {
    bitmap?.close();
    bitmap = null;
  }
  onDestroy(() => {
    alive = false;
    version++;
    release();
  });
  $effect(() => {
    if (!open) release();
  });
  async function select(): Promise<void> {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file || busy || reading) return;
    error = null;
    if (file.type !== '' && !avatarImageTypes.includes(file.type)) {
      error = t('avatarTypeInvalid');
      return;
    }
    // 巨大な写真を復号してタブを止めないため、元ファイルも20MiBまでに限る。
    if (file.size > AVATAR_SOURCE_MAX_BYTES) {
      error = t('avatarSourceTooLarge', { max: AVATAR_SOURCE_MAX_BYTES / 1024 / 1024 });
      return;
    }
    const selectedSlug = slug;
    const token = ++version;
    reading = true;
    try {
      if (!(await isAvatarSource(file))) {
        if (alive && selectedSlug === slug) error = t('avatarTypeInvalid');
        return;
      }
      const decoded = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (!alive || token !== version || selectedSlug !== slug) {
        decoded.close();
        return;
      }
      release();
      bitmap = decoded;
      cropError = null;
      dialog.show(chooseButton);
    } catch {
      if (alive && selectedSlug === slug) error = t('avatarDecodeFailed');
    } finally {
      if (alive) reading = false;
    }
  }
  async function save(remove = false): Promise<void> {
    if (busy || (!remove && (!bitmap || !cropper))) return;
    const sentSlug = slug;
    const restoreFocus =
      remove &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.avatarRemove !== undefined;
    busy = true;
    error = null;
    cropError = null;
    try {
      const blob = remove ? null : await cropper!.encode();
      if (blob && blob.size > AVATAR_MAX_BYTES) {
        cropError = t('avatarOutputTooLarge', { max: AVATAR_MAX_BYTES / 1024 });
        return;
      }
      if (!alive || sentSlug !== slug) return;
      const result = blob
        ? await uploadAvatar(blob, sentSlug)
        : await callOperation(meAvatarDelete, {}, { slug: sentSlug });
      if (!alive || sentSlug !== slug) return;
      if (!result.ok) {
        if (isUnauthenticated(result)) {
          window.location.assign(loginUrl(page.url));
          return;
        }
        const message =
          result.status === 400 || result.status === 413
            ? t('avatarRejected', { bytes: AVATAR_MAX_BYTES / 1024, pixels: AVATAR_MAX_PIXELS })
            : t('avatarSaveFailed');
        if (remove) error = message;
        else cropError = message;
        return;
      }
      open = false;
      showToast(t(remove ? 'avatarRemoved' : 'avatarSaved'));
      await invalidate((url) => url.pathname === operationPath(organizationInfo, sentSlug));
      await tick();
      if (alive && sentSlug === slug && restoreFocus && document.activeElement === document.body) chooseButton.focus();
    } catch {
      if (alive && sentSlug === slug) {
        if (remove) error = t('avatarSaveFailed');
        else cropError = t('avatarSaveFailed');
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<Setting title={t('avatarTitle')} description={t('avatarDescription')}>
  <Avatar {userId} {name} {image} large />
  <input
    hidden
    type="file"
    accept="image/png,image/jpeg,image/webp"
    aria-label={t('avatarChoose')}
    bind:this={picker}
    onchange={() => void select()}
  />
  <div class="form-actions">
    <button
      class="btn"
      type="button"
      bind:this={chooseButton}
      aria-disabled={busy || reading}
      onclick={() => {
        if (!busy && !reading) picker.click();
      }}>{t('avatarChoose')}</button
    >
    {#if uploaded}<button
        class="btn is-quiet"
        type="button"
        data-avatar-remove
        aria-disabled={busy || reading}
        onclick={() => {
          if (!reading) void save(true);
        }}>{t('avatarRemove')}</button
      >{/if}
  </div>
  <div role="alert" class:visually-hidden={!error}>
    {#if error}<span class="field-error"><Icon name="alert" />{error}</span>{/if}
  </div>
  <span class="visually-hidden" role="status">{busy ? t('avatarSaving') : reading ? t('avatarReading') : ''}</span>
</Setting>
<Dialog bind:this={dialog} bind:open title={t('avatarCropTitle')} dismissible={!busy}>
  {#if bitmap}<ImageCrop image={bitmap} disabled={busy} bind:this={cropper} />{/if}
  <div role="alert" class:visually-hidden={!cropError}>
    {#if cropError}<span class="field-error"><Icon name="alert" />{cropError}</span>{/if}
  </div>
  <span class="visually-hidden" role="status">{busy ? t('avatarSaving') : ''}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={busy} onclick={close}>{t('avatarCancel')}</button>
    <button class="btn is-primary" type="button" aria-disabled={busy} onclick={() => void save()}
      >{busy ? t('avatarSaving') : t('avatarUpload')}</button
    >
  {/snippet}
</Dialog>
