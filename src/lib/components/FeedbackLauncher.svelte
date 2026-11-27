<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { tick, untrack } from 'svelte';
  import { callOperation } from '../api.ts';
  import {
    FEEDBACK_IMAGE_MAX_COUNT,
    FEEDBACK_MESSAGE_PARAMS as params,
    admitFeedbackImages,
    clipboardImages,
    feedbackFailure,
    feedbackImageSize,
    feedbackInput,
    feedbackStallMs,
    validateFeedback,
  } from '../feedback-form.ts';
  import { feedbackDraft } from '../feedback-draft.svelte.ts';
  import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import { feedbackSubmit } from '../../shared/operations/feedback.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // ログインした画面の右下に固定する、フィードバックの入口（見本はカタログの「フィードバックの入口」と kit.js の DIALOGS.feedback）。
  // 置くのは、ログインを前提に読み込む画面（組織の枠、組織の選択、運用）だけ。root のレイアウトはログインの状態を持たないので置かない。
  // 押すとダイアログが開き、文を feedback-submit で送る。送った文は公開の GitHub の Issue に載るので、ダイアログの先頭にそう出す。
  // 送れたら閉じてトーストを出し、入力を空にする。送れなかったら閉じずに入力を残し、欄の下に理由を出す。
  // 書いた文と送っている途中の印は feedback-draft.svelte.ts に持ち、置いた画面をまたいで移っても残す。
  // 送っている間は欄を読むだけにし、送るボタンを止めて二重に送らない（開き直しても、別の画面の入口から開いても残る）。
  // 応答が 30 秒来なければ詰まったとみなし、送り直せるようにする（同じ文が2件になりうることを欄の下に出す）。
  // 閉じる操作は止めない（書き込みは画面で打ち切らないので、通信が詰まったときにダイアログから出られなくなるため）。
  // 閉じた後に送れたらトーストで知らせて入力を空にし、送れなかったら理由をトーストで知らせて入力を残す。
  // ログインが切れた（401）と同意していない（403 の terms_required）は、画面ごと移るので書いた文は残らない。
  // 規約の文書は別のタブで開き、書いている文を失わない。

  const ids = $props.id();
  const fieldId = `${ids}-text`;
  const hintId = `${ids}-hint`;
  const publicId = `${ids}-public`;
  const errorId = `${ids}-error`;
  const imageHintId = `${ids}-image-hint`;
  const imageLabelId = `${ids}-image-label`;

  let dialog = $state<ReturnType<typeof Dialog>>();
  let launcher = $state<HTMLButtonElement>();
  let textarea = $state<HTMLTextAreaElement>();
  let picker = $state<HTMLInputElement>();
  let chooseButton = $state<HTMLButtonElement>();
  let open = $state(false);
  // 画像をドラッグで重ねている間。付けた・外したを読み上げに伝える文
  let over = $state(false);
  let imageStatus = $state('');
  const imagesFull = $derived(feedbackDraft.images.length >= FEEDBACK_IMAGE_MAX_COUNT);
  const error = $derived(feedbackDraft.error);
  // 送っていて、まだ詰まったとみなしていない間だけ、欄を読むだけにして送るボタンを止める
  const waiting = $derived(feedbackDraft.sending && !feedbackDraft.stalled);

  // 開いている間だけ数える。送り終わりの知らせを、欄の下に出すかトーストにするかを決める
  $effect(() => {
    if (!open) return;
    untrack(() => feedbackDraft.openCount++);
    return () => untrack(() => feedbackDraft.openCount--);
  });

  // 送れたら、どの部品から送り始めたかにかかわらず、開いているダイアログを閉じる
  let seenSent = untrack(() => feedbackDraft.sent);
  $effect(() => {
    const sent = feedbackDraft.sent;
    if (sent === seenSent) return;
    seenSent = sent;
    untrack(() => (open = false));
  });

  // 理由が出たら欄へフォーカスを戻す（送り始めた部品が外れていても、今開いている部品が受け持つ）
  $effect(() => {
    if (feedbackDraft.error !== null && open) untrack(() => textarea?.focus());
  });

  function show(): void {
    setError(null);
    feedbackDraft.imageProblems = [];
    imageStatus = '';
    dialog?.show(launcher);
  }

  function setError(value: DictionaryKey | null): void {
    feedbackDraft.error = value;
  }

  // 送れた。送った文と今の欄の文が同じときだけ空にしてダイアログを閉じる（詰まった後に直している文を消さない）。
  // 送り直した後に前の送信が送れたときは、送り直した方の結果を待たない（attempt を進めて、その結果は捨てる側に回す）
  function delivered(attempt: number, sentText: string, sentImages: readonly File[]): void {
    if (feedbackDraft.attempt !== attempt) feedbackDraft.attempt++;
    feedbackDraft.sending = false;
    feedbackDraft.stalled = false;
    setError(null);
    // 送った文と画像が今の欄と同じときだけ空にする（詰まった後に足した画像を消さない）
    const sameImages =
      feedbackDraft.images.length === sentImages.length &&
      feedbackDraft.images.every((file, i) => file === sentImages[i]);
    if (feedbackDraft.text === sentText && sameImages) {
      feedbackDraft.text = '';
      feedbackDraft.images = [];
      feedbackDraft.imageProblems = [];
      feedbackDraft.sent++;
    }
    showToast(t('feedbackSent'), 'check');
  }

  // 付けようとしたファイルを確かめて足す。続けて呼ばれても、付けた枚数を数え直してから足す（上限を越えない）
  let admitting: Promise<void> = Promise.resolve();
  // 同じ文が続いても読み上げられるよう、一度空にしてから入れ直す
  function announce(text: string): void {
    imageStatus = '';
    if (text !== '') void tick().then(() => (imageStatus = text));
  }
  function addImages(files: readonly File[]): void {
    if (files.length === 0) return;
    if (waiting) {
      announce(t('feedbackImageBusy'));
      return;
    }
    admitting = admitting
      .then(async () => {
        const { accepted, rejected } = await admitFeedbackImages(feedbackDraft.images, files);
        // 確かめている間に送り始めたら、送った分とずれるので足さない
        if (waiting) {
          announce(t('feedbackImageBusy'));
          return;
        }
        feedbackDraft.images = [...feedbackDraft.images, ...accepted];
        feedbackDraft.imageProblems = rejected;
        // 同じ名前を続けて付けても読み上げられるよう、通し番号を添えて毎回違う文にする
        announce(
          accepted.length === 0 ? '' : t('feedbackImageAdded', { name: accepted.map((f) => f.name).join('、') }),
        );
        if (imagesFull)
          void tick().then(() =>
            document.activeElement === document.body || !dialogHasFocus() ? textarea?.focus() : undefined,
          );
      })
      // 1回の失敗で、以後の追加が止まらないようにする
      .catch(() => undefined);
  }

  function dialogHasFocus(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest('dialog') !== null && active !== active.closest('dialog');
  }

  function removeImage(file: File): void {
    if (waiting) return;
    feedbackDraft.images = feedbackDraft.images.filter((item) => item !== file);
    feedbackDraft.imageProblems = [];
    announce(t('feedbackImageRemoved', { name: file.name }));
    void tick().then(() => (chooseButton ?? textarea)?.focus());
  }

  function picked(): void {
    if (picker === undefined) return;
    addImages([...(picker.files ?? [])]);
    // 同じファイルを選び直しても change が届くよう、選びを空に戻す
    picker.value = '';
  }

  // 画像だけの貼り付け（スクリーンショットなど）を画像として付ける。文字も一緒のとき（表計算のセルなど）は文字の貼り付けに任せる
  function paste(event: ClipboardEvent): void {
    const clipboard = event.clipboardData;
    if (clipboard === null || clipboard.files.length === 0) return;
    const images = clipboardImages([...clipboard.files], clipboard.getData('text/plain'));
    if (images.length === 0) return;
    event.preventDefault();
    addImages(images);
  }

  function carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') === true;
  }

  // 落とす先はダイアログが開いている間の画面全体で受ける（見出し、フッター、背景に落としても、ブラウザがファイルを開いて書きかけを失わないように）
  function dragover(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const accepting = !waiting && !imagesFull;
    if (event.dataTransfer) event.dataTransfer.dropEffect = accepting ? 'copy' : 'none';
    over = accepting;
  }

  // 入った数と出た数を数え、画面の外へ出たときだけ戻す（relatedTarget を渡さないブラウザでも、子の間の移動でちらつかない）
  let dragDepth = 0;
  function dragenter(event: DragEvent): void {
    if (carriesFiles(event)) dragDepth++;
  }

  function dragleave(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) over = false;
  }

  function drop(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    over = false;
    dragDepth = 0;
    addImages([...(event.dataTransfer?.files ?? [])]);
  }

  $effect(() => {
    if (!open) return;
    window.addEventListener('dragenter', dragenter);
    window.addEventListener('dragover', dragover);
    window.addEventListener('dragleave', dragleave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', dragenter);
      window.removeEventListener('dragover', dragover);
      window.removeEventListener('dragleave', dragleave);
      window.removeEventListener('drop', drop);
      over = false;
      dragDepth = 0;
    };
  });

  // 送り終わったら、送っている間は付けられない、の知らせを消す
  const imageBusy = $derived(imageStatus === t('feedbackImageBusy'));
  $effect(() => {
    if (!waiting && untrack(() => imageBusy)) imageStatus = '';
  });

  // 付ける前の画像の縮小を canvas に描く（CSP の img-src が blob: を許さないので <img> に URL を渡さない）。
  // 中央を正方形に切り抜く。読めない画像は地のまま残す
  function thumbnail(node: HTMLCanvasElement, file: File) {
    let gone = false;
    const side = 96;
    node.width = side;
    node.height = side;
    createImageBitmap(file)
      .then((bitmap) => {
        const context = node.getContext('2d');
        if (!gone && context !== null) {
          const crop = Math.min(bitmap.width, bitmap.height);
          context.drawImage(
            bitmap,
            (bitmap.width - crop) / 2,
            (bitmap.height - crop) / 2,
            crop,
            crop,
            0,
            0,
            side,
            side,
          );
        }
        bitmap.close();
      })
      .catch(() => undefined);
    return {
      destroy() {
        gone = true;
      },
    };
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (waiting) return;
    const invalid = validateFeedback(feedbackDraft.text);
    if (invalid !== null) {
      setError(invalid);
      textarea?.focus();
      return;
    }
    const attempt = ++feedbackDraft.attempt;
    const sentText = feedbackDraft.text;
    const sentImages = [...feedbackDraft.images];
    feedbackDraft.sending = true;
    feedbackDraft.stalled = false;
    setError(null);
    // 前の送信でサーバーが画像を断った理由は消す（付けたときの断りは、名前があるので残す）
    feedbackDraft.imageProblems = feedbackDraft.imageProblems.filter((problem) => problem.name !== '');
    const stallTimer = setTimeout(
      () => {
        if (feedbackDraft.attempt === attempt) feedbackDraft.stalled = true;
      },
      feedbackStallMs(sentImages.reduce((total, file) => total + file.size, 0)),
    );
    try {
      const result = await callOperation(feedbackSubmit, feedbackInput(sentText, page.route.id, window.location), {
        files: sentImages,
      });
      if (result.ok) {
        delivered(attempt, sentText, sentImages);
        return;
      }
      // 送り直した後か、前の送信が送れた後に、捨てた側の送信の失敗が届いた。画面の状態は変えない
      if (feedbackDraft.attempt !== attempt) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (isTermsRequired(result)) {
        window.location.assign(consentUrl(page.url));
        return;
      }
      const reason = feedbackFailure(result);
      // 送り始めた部品が外れていても、今どこかでダイアログが開いていれば、その欄の下に出す
      if (feedbackDraft.openCount > 0) {
        // 画像の理由は画像の欄に出す（文の欄を誤りにしない）
        if (reason.startsWith('feedbackImage')) feedbackDraft.imageProblems = [{ name: '', reason }];
        else setError(reason);
      } else {
        showToast(t('feedbackFailedClosed', { reason: t(reason, params) }), 'alert');
      }
    } finally {
      clearTimeout(stallTimer);
      if (feedbackDraft.attempt === attempt) {
        feedbackDraft.sending = false;
        feedbackDraft.stalled = false;
      }
    }
  }
</script>

<button
  class="feedback-launch"
  type="button"
  bind:this={launcher}
  aria-label={t('feedbackOpen')}
  title={t('feedbackOpen')}
  aria-haspopup="dialog"
  onclick={show}
>
  <Icon name="message" />
</button>

<Dialog bind:this={dialog} bind:open title={t('feedbackTitle')}>
  <!-- 中身は開いている間だけ描く。閉じている間に、囲みや欄が画面の DOM に残らないようにする（書いた文は feedbackDraft に残る） -->
  {#if open}
    <!-- 貼り付けはダイアログの中身全体で受ける。落とすは上の window で受ける -->
    <form class="form" id="{ids}-form" onsubmit={submit} onpaste={paste} novalidate>
      <div class="callout is-info" id={publicId}>
        <Icon name="alert" />
        <span
          >{t('feedbackPublic')}
          <a href={resolve('/privacy')} target="_blank" rel="noopener noreferrer"
            >{t('feedbackPrivacy')}<Icon name="external" /><span class="visually-hidden">{t('markdownNewTab')}</span></a
          ></span
        >
      </div>
      <div class="field" class:is-invalid={error !== null}>
        <label class="field-label" for={fieldId}>{t('feedbackField')}</label>
        <textarea
          class="textarea"
          id={fieldId}
          rows="6"
          bind:this={textarea}
          bind:value={feedbackDraft.text}
          oninput={() => setError(null)}
          readonly={waiting}
          aria-invalid={error !== null}
          aria-describedby="{publicId} {hintId}{error !== null ? ` ${errorId}` : ''}"></textarea>
        <p class="field-hint" id={hintId}>{t('feedbackHint', params)}</p>
        {#if feedbackDraft.sending && feedbackDraft.stalled}<div class="callout is-warn">
            <Icon name="alert" /><span>{t('feedbackStalled')}</span>
          </div>{/if}
        {#if error !== null}<span class="field-error" id={errorId} role="alert"
            ><Icon name="alert" />{t(error, params)}</span
          >{/if}
      </div>
      <div
        class="field"
        class:is-invalid={feedbackDraft.imageProblems.length > 0}
        role="group"
        aria-labelledby={imageLabelId}
      >
        <span class="field-label" id={imageLabelId}>{t('feedbackImageField')}</span>
        {#if feedbackDraft.images.length > 0}
          <ul class="files" aria-label={t('feedbackImageListLabel')}>
            {#each feedbackDraft.images as file (file)}
              <li class="file-row">
                <canvas class="file-preview" aria-hidden="true" use:thumbnail={file}></canvas>
                <div class="file-main">
                  <span class="file-name">{file.name}</span>
                  <span class="file-meta mono">{feedbackImageSize(file.size)}</span>
                </div>
                <div class="file-actions">
                  <button
                    class="btn is-sm is-quiet"
                    type="button"
                    disabled={waiting}
                    aria-label={t('feedbackImageRemoveLabel', { name: file.name })}
                    onclick={() => removeImage(file)}>{t('feedbackImageRemove')}</button
                  >
                </div>
              </li>
            {/each}
          </ul>
        {/if}
        {#if imagesFull}
          <div class="dropzone is-disabled">
            <Icon name="alert" />
            <span class="dropzone-text"
              ><b>{t('feedbackImageFull', params)}</b><span id={imageHintId}>{t('feedbackImageFullHint')}</span></span
            >
          </div>
        {:else}
          <div class="dropzone" class:is-over={over}>
            <Icon name="upload" />
            <span class="dropzone-text"
              ><b>{over ? t('feedbackImageDropOver') : t('feedbackImageDrop')}</b><span id={imageHintId}
                >{t('feedbackImageHint', params)}</span
              ></span
            >
            <button
              class="btn is-sm"
              type="button"
              bind:this={chooseButton}
              disabled={waiting}
              aria-describedby={imageHintId}
              onclick={() => picker?.click()}><Icon name="clip" />{t('feedbackImageChoose')}</button
            >
          </div>
        {/if}
        <input
          class="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          tabindex="-1"
          aria-hidden="true"
          data-feedback-images
          bind:this={picker}
          onchange={picked}
        />
        {#if imageBusy}<p class="field-hint">{t('feedbackImageBusy')}</p>{/if}
        {#each feedbackDraft.imageProblems as problem, index (index)}
          <span class="field-error" role="alert"
            ><Icon name="alert" />{problem.name === ''
              ? t(problem.reason, params)
              : t('feedbackImageRejected', { name: problem.name, reason: t(problem.reason, params) })}</span
          >
        {/each}
      </div>
      <!-- 送っている間と詰まったときは、目にはボタンの文言と欄の下の囲みで、読み上げには常に置いたこの領域で伝える -->
      <span class="visually-hidden" role="status"
        >{waiting ? t('feedbackSending') : feedbackDraft.sending ? t('feedbackStalled') : ''}</span
      >
      <span class="visually-hidden" role="status">{imageStatus}</span>
    </form>
  {/if}
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form="{ids}-form" aria-disabled={waiting}
      >{waiting ? t('feedbackSending') : t('feedbackSend')}</button
    >
  {/snippet}
</Dialog>
