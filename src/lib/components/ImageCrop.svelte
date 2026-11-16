<script lang="ts">
  import { cropSquare, drawCrop, encodeAvatar } from '../image-crop.ts';
  import { t } from '../vocabulary.svelte.ts';

  let { image, disabled = false }: { image: ImageBitmap; disabled?: boolean } = $props();
  const ids = $props.id();
  let canvas: HTMLCanvasElement;
  let zoom = $state(1);
  let x = $state(0);
  let y = $state(0);
  let dragging: { id: number; x: number; y: number } | null = null;
  $effect(() => {
    x = image.width / 2;
    y = image.height / 2;
    zoom = 1;
  });
  const crop = $derived(cropSquare(image.width, image.height, zoom, x, y));
  $effect(() => {
    const context = canvas?.getContext('2d');
    if (context) drawCrop(context, image, crop);
  });
  function move(dx: number, dy: number): void {
    if (disabled) return;
    const next = cropSquare(image.width, image.height, zoom, crop.x + crop.size / 2 + dx, crop.y + crop.size / 2 + dy);
    x = next.x + next.size / 2;
    y = next.y + next.size / 2;
  }
  function keydown(event: KeyboardEvent): void {
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = delta[event.key];
    if (!direction || event.isComposing) return;
    event.preventDefault();
    move((direction[0] * crop.size) / 50, (direction[1] * crop.size) / 50);
  }
  export async function encode(): Promise<Blob> {
    return encodeAvatar(canvas);
  }
</script>

<div class="image-crop">
  <p class="field-hint" id="{ids}-hint">{t('avatarCropHint')}</p>
  <div
    role="img"
    class="image-crop-preview"
    aria-label={t('avatarCropArea')}
    aria-describedby="{ids}-hint {ids}-position"
    data-disabled={disabled}
    onpointerdown={(event) => {
      if (disabled || !event.isPrimary || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }}
    onpointermove={(event) => {
      if (dragging?.id !== event.pointerId) return;
      const scale = crop.size / event.currentTarget.getBoundingClientRect().width;
      move((dragging.x - event.clientX) * scale, (dragging.y - event.clientY) * scale);
      dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }}
    onpointerup={() => (dragging = null)}
    onpointercancel={() => (dragging = null)}
    onlostpointercapture={() => (dragging = null)}
  >
    <canvas width="256" height="256" bind:this={canvas} aria-hidden="true"></canvas>
  </div>
  <span class="field-hint" id="{ids}-position" role="status" aria-live="polite" aria-atomic="true"
    >{t('avatarCropPosition', {
      x: Math.round(((crop.x + crop.size / 2) / image.width) * 100),
      y: Math.round(((crop.y + crop.size / 2) / image.height) * 100),
    })}</span
  >
  <div class="form-actions" role="group" aria-label={t('avatarCropMove')}>
    <button
      class="btn"
      type="button"
      aria-disabled={disabled}
      onkeydown={keydown}
      onclick={() => move(-crop.size / 10, 0)}>{t('avatarCropLeft')}</button
    >
    <button
      class="btn"
      type="button"
      aria-disabled={disabled}
      onkeydown={keydown}
      onclick={() => move(crop.size / 10, 0)}>{t('avatarCropRight')}</button
    >
    <button
      class="btn"
      type="button"
      aria-disabled={disabled}
      onkeydown={keydown}
      onclick={() => move(0, -crop.size / 10)}>{t('avatarCropUp')}</button
    >
    <button
      class="btn"
      type="button"
      aria-disabled={disabled}
      onkeydown={keydown}
      onclick={() => move(0, crop.size / 10)}>{t('avatarCropDown')}</button
    >
  </div>
  <label class="field" for="{ids}-zoom"
    ><span class="field-label">{t('avatarCropZoom')}</span>
    <input
      id="{ids}-zoom"
      type="range"
      min="1"
      max="4"
      step="0.05"
      aria-valuetext={t('avatarCropZoomValue', { value: zoom.toFixed(2) })}
      bind:value={zoom}
      {disabled}
    />
  </label>
</div>
