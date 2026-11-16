// 見本も本番と同じ部品の構造・辞書・操作にする。画像の保存は通信せず画面の中だけ。
(() => {
  const { t, esc, icon } = SQ;
  const settingStates = new Map();
  const format = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t(key));
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  let current = null;

  function imageCropHtml(id, { disabled = false } = {}) {
    return `<div class="image-crop" data-image-crop data-crop-disabled="${disabled}">
      <p class="field-hint" id="${id}-hint">${t("avatarCropHint")}</p>
      <div class="image-crop-preview" role="img" aria-label="${t("avatarCropArea")}" aria-describedby="${id}-hint ${id}-position" data-disabled="${disabled}"><canvas width="256" height="256" aria-hidden="true"></canvas></div>
      <span class="field-hint" id="${id}-position" role="status" aria-live="polite" aria-atomic="true" data-crop-position>${format("avatarCropPosition", { x: 50, y: 50 })}</span>
      <div class="form-actions" role="group" aria-label="${t("avatarCropMove")}">
        ${[["Left", "avatarCropLeft"], ["Right", "avatarCropRight"], ["Up", "avatarCropUp"], ["Down", "avatarCropDown"]].map(([direction, key]) => `<button class="btn" type="button" data-crop-move="Arrow${direction}" aria-disabled="${disabled}">${t(key)}</button>`).join("")}
      </div>
      <label class="field" for="${id}-zoom"><span class="field-label">${t("avatarCropZoom")}</span><input id="${id}-zoom" type="range" min="1" max="4" step="0.05" value="1" aria-valuetext="${format("avatarCropZoomValue", { value: "1.00" })}" ${disabled ? "disabled" : ""}></label>
    </div>`;
  }

  function avatarSettingHtml(id, options = {}) {
    if (!settingStates.has(id)) settingStates.set(id, { options, image: options.image || null, error: options.error || "", busy: false });
    const state = settingStates.get(id);
    const me = SQ.user(SQ.D.me);
    const image = state.options.syncAccount ? me.avatar_url || null : state.image;
    return `<section class="setting" aria-labelledby="${id}-title" data-avatar-setting="${id}">
      <div class="setting-head"><h2 class="setting-title" id="${id}-title">${t("avatarTitle")}</h2><p class="setting-desc">${t("avatarDescription")}</p></div>
      <div class="setting-body">${SQ.avatar(me.name, me.hue, { lg: true, image })}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="${t("avatarChoose")}" data-avatar-picker>
        <div class="form-actions"><button class="btn" type="button" data-avatar-choose aria-disabled="${state.busy}">${t("avatarChoose")}</button>${image ? `<button class="btn is-quiet" type="button" data-avatar-remove aria-disabled="${state.busy}">${t("avatarRemove")}</button>` : ""}</div>
        <div role="alert" class="${state.error ? "" : "visually-hidden"}" data-avatar-error>${state.error ? `<span class="field-error">${icon("alert")}${esc(state.error)}</span>` : ""}</div>
        <span class="visually-hidden" role="status" data-avatar-status>${state.busy ? t("avatarReading") : ""}</span>
      </div></section>`;
  }

  function sampleImage() {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const paint = canvas.getContext("2d"), colors = ["#0b57d0", "#e8effc", "#58636f"];
    for (let row = 0; row < 6; row++) for (let col = 0; col < 8; col++) {
      paint.fillStyle = colors[(row + col) % colors.length]; paint.fillRect(col * 50, row * 50, 50, 50);
    }
    return canvas;
  }

  function mount(root, source) {
    if (root.dataset.cropMounted) return;
    source ??= sampleImage();
    root.dataset.cropMounted = "true";
    const canvas = root.querySelector("canvas"), ctx = canvas.getContext("2d");
    const preview = root.querySelector(".image-crop-preview"), range = root.querySelector('input[type="range"]');
    let x = source.width / 2, y = source.height / 2, zoom = 1, drag = null;
    const disabled = () => root.dataset.cropDisabled === "true";
    const size = () => Math.min(source.width, source.height) / zoom;
    function draw(dx = 0, dy = 0) {
      const edge = size();
      x = Math.max(edge / 2, Math.min(source.width - edge / 2, x + dx));
      y = Math.max(edge / 2, Math.min(source.height - edge / 2, y + dy));
      ctx.clearRect(0, 0, 256, 256); ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, x - edge / 2, y - edge / 2, edge, edge, 0, 0, 256, 256);
      root.querySelector("[data-crop-position]").textContent = format("avatarCropPosition", { x: Math.round(x / source.width * 100), y: Math.round(y / source.height * 100) });
      range.setAttribute("aria-valuetext", format("avatarCropZoomValue", { value: zoom.toFixed(2) }));
    }
    range.oninput = () => { if (!disabled()) { zoom = Number(range.value); draw(); } };
    root.querySelectorAll("[data-crop-move]").forEach((button) => {
      button.onclick = () => { if (disabled()) return; const d = directions[button.dataset.cropMove]; draw(d[0] * size() / 10, d[1] * size() / 10); };
      button.onkeydown = (event) => { const d = directions[event.key]; if (!d || event.isComposing) return; event.preventDefault(); if (!disabled()) draw(d[0] * size() / 50, d[1] * size() / 50); };
    });
    preview.onpointerdown = (event) => { if (disabled() || !event.isPrimary || event.button !== 0) return; preview.setPointerCapture(event.pointerId); drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; };
    preview.onpointermove = (event) => { if (drag?.id !== event.pointerId || disabled()) return; const scale = size() / preview.getBoundingClientRect().width; draw(-(event.clientX - drag.x) * scale, -(event.clientY - drag.y) * scale); drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; };
    preview.onpointerup = preview.onpointercancel = preview.onlostpointercapture = () => { drag = null; };
    draw();
  }

  function refreshSetting(id) {
    const root = document.querySelector(`[data-avatar-setting="${id}"]`);
    if (root) root.outerHTML = avatarSettingHtml(id);
  }
  function release() {
    current?.observer?.disconnect(); current?.source?.close?.(); current = null;
  }
  function openCrop(id, source, opener) {
    release();
    const state = settingStates.get(id);
    state.error = "";
    opener.focus();
    SQ.openDialog(t("avatarCropTitle"), `${imageCropHtml("avatar-dialog-crop")}<div role="alert" class="visually-hidden" data-avatar-crop-error></div><span class="visually-hidden" role="status" data-avatar-crop-status></span>`, `<button class="btn is-quiet" type="button" data-close-dialog>${t("avatarCancel")}</button><button class="btn is-primary" type="button" data-avatar-upload>${t("avatarUpload")}</button>`);
    const dialog = document.getElementById("dialog"), root = dialog.querySelector("[data-image-crop]");
    current = { id, source, root, dialog, busy: false };
    mount(root, source);
    const observer = new MutationObserver(() => { if (current?.root === root && (dialog.hidden || !dialog.contains(root))) release(); });
    current.observer = observer;
    observer.observe(dialog, { attributes: true, attributeFilter: ["hidden"], childList: true });
  }
  function setBusy(value) {
    if (!current) return;
    current.busy = value; current.root.dataset.cropDisabled = String(value);
    current.dialog.querySelectorAll("button").forEach((element) => element.setAttribute("aria-disabled", String(value)));
    current.root.querySelector(".image-crop-preview").dataset.disabled = String(value);
    current.root.querySelector("input").disabled = value;
    current.dialog.querySelector("[data-avatar-crop-status]").textContent = value ? t("avatarSaving") : "";
    current.dialog.querySelector("[data-avatar-upload]").textContent = t(value ? "avatarSaving" : "avatarUpload");
  }
  async function validSource(file) {
    if (file.type && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) return false;
    const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const detected = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v) ? "image/png" : b[0] === 255 && b[1] === 216 && b[2] === 255 ? "image/jpeg" : b.length === 12 && new TextDecoder().decode(b.slice(0, 4)) === "RIFF" && new TextDecoder().decode(b.slice(8, 12)) === "WEBP" ? "image/webp" : null;
    return detected !== null && (!file.type || file.type === detected);
  }

  document.addEventListener("change", async (event) => {
    const input = event.target.closest?.("[data-avatar-picker]");
    if (!input) return;
    const id = input.closest("[data-avatar-setting]").dataset.avatarSetting, state = settingStates.get(id), file = input.files?.[0];
    input.value = "";
    if (!file || state.busy) return;
    state.error = ""; state.busy = true;
    refreshSetting(id);
    try {
      if (file.size > 20 * 1024 * 1024) { state.error = format("avatarSourceTooLarge", { max: 20 }); return; }
      if (!(await validSource(file))) { state.error = t("avatarTypeInvalid"); return; }
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      state.busy = false; refreshSetting(id);
      const opener = document.querySelector(`[data-avatar-setting="${id}"] [data-avatar-choose]`);
      if (!opener) { bitmap.close(); return; }
      openCrop(id, bitmap, opener);
    } catch { state.error = t("avatarDecodeFailed"); }
    finally { state.busy = false; if (current?.id !== id) refreshSetting(id); }
  });
  document.addEventListener("click", (event) => {
    const choose = event.target.closest?.("[data-avatar-choose]"), remove = event.target.closest?.("[data-avatar-remove]");
    if (choose || remove) {
      const element = choose || remove, id = element.closest("[data-avatar-setting]").dataset.avatarSetting, state = settingStates.get(id);
      if (state.busy) return;
      if (choose) element.closest("[data-avatar-setting]").querySelector("[data-avatar-picker]").click();
      else {
        state.image = null; state.error = "";
        if (state.options.syncAccount) SQ.user(SQ.D.me).avatar_url = null;
        refreshSetting(id); if (state.options.syncAccount) SQ.redraw();
        document.querySelector(`[data-avatar-setting="${id}"] [data-avatar-choose]`)?.focus();
        SQ.toast(t("avatarRemoved"));
      }
      return;
    }
    if (!event.target.closest?.("[data-avatar-upload]") || !current || current.busy) return;
    setBusy(true);
    const pending = current;
    setTimeout(() => {
      if (current !== pending) return;
      try {
        const canvas = pending.root.querySelector("canvas");
        let image = canvas.toDataURL("image/webp", 0.9);
        if (!image.startsWith("data:image/webp")) {
          const fallback = document.createElement("canvas"); fallback.width = fallback.height = 256;
          const context = fallback.getContext("2d"); context.fillStyle = "#fff"; context.fillRect(0, 0, 256, 256); context.drawImage(canvas, 0, 0);
          image = fallback.toDataURL("image/jpeg", 0.9);
        }
        const state = settingStates.get(pending.id); state.image = image; state.error = "";
        if (state.options.syncAccount) SQ.user(SQ.D.me).avatar_url = image;
        SQ.closeDialog(); release(); refreshSetting(pending.id); if (state.options.syncAccount) SQ.redraw();
        document.querySelector(`[data-avatar-setting="${pending.id}"] [data-avatar-choose]`)?.focus();
        SQ.toast(t("avatarSaved"));
      } catch {
        setBusy(false);
        const error = pending.dialog.querySelector("[data-avatar-crop-error]");
        error.classList.remove("visually-hidden"); error.innerHTML = `<span class="field-error">${icon("alert")}${t("avatarSaveFailed")}</span>`;
      }
    }, 800);
  });
  // 本番の dismissible={!busy} と同じく、送信中は×・背景・Escでも閉じない。
  document.addEventListener("click", (event) => { if (current?.busy && (event.target === current.dialog || event.target.closest?.("[data-close-dialog]"))) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  document.addEventListener("keydown", (event) => { if (current?.busy && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  const mountAll = () => document.querySelectorAll("[data-image-crop]").forEach((root) => mount(root));
  Object.assign(SQ, { imageCropHtml, avatarSettingHtml });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll, { once: true });
  else mountAll();
  SQ.onRedraw(() => queueMicrotask(mountAll));
})();
