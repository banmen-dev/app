<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { callOperation } from '../api.ts';
  import { FEEDBACK_TEXT_MAX, feedbackFailure, feedbackInput, validateFeedback } from '../feedback-form.ts';
  import { FEEDBACK_STALL_MS, feedbackDraft } from '../feedback-draft.svelte.ts';
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

  let dialog = $state<ReturnType<typeof Dialog>>();
  let launcher = $state<HTMLButtonElement>();
  let textarea = $state<HTMLTextAreaElement>();
  let open = $state(false);
  const error = $derived(feedbackDraft.error);
  // 送っていて、まだ詰まったとみなしていない間だけ、欄を読むだけにして送るボタンを止める
  const waiting = $derived(feedbackDraft.sending && !feedbackDraft.stalled);

  const max = FEEDBACK_TEXT_MAX.toLocaleString('ja-JP');

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
    dialog?.show(launcher);
  }

  function setError(value: DictionaryKey | null): void {
    feedbackDraft.error = value;
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
    feedbackDraft.sending = true;
    feedbackDraft.stalled = false;
    setError(null);
    const stallTimer = setTimeout(() => {
      if (feedbackDraft.attempt === attempt) feedbackDraft.stalled = true;
    }, FEEDBACK_STALL_MS);
    try {
      const result = await callOperation(
        feedbackSubmit,
        feedbackInput(feedbackDraft.text, page.route.id, window.location),
      );
      // 詰まったとみなして送り直した後に、前の送信の応答が届いた。送れていれば知らせるだけにし、今の送信の状態は変えない
      if (feedbackDraft.attempt !== attempt) {
        if (result.ok) showToast(t('feedbackSent'), 'check');
        return;
      }
      if (result.ok) {
        feedbackDraft.text = '';
        setError(null);
        feedbackDraft.sent++;
        showToast(t('feedbackSent'), 'check');
        return;
      }
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
        setError(reason);
      } else {
        showToast(t('feedbackFailedClosed', { reason: t(reason, { max }) }), 'alert');
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
    <form class="form" id="{ids}-form" onsubmit={submit} novalidate>
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
        <p class="field-hint" id={hintId}>{t('feedbackHint', { max })}</p>
        {#if feedbackDraft.sending && feedbackDraft.stalled}<p class="field-hint" role="status">
            <Icon name="alert" />{t('feedbackStalled')}
          </p>{/if}
        {#if error !== null}<span class="field-error" id={errorId} role="alert"
            ><Icon name="alert" />{t(error, { max })}</span
          >{/if}
      </div>
      <!-- 送っている間は、目にはボタンの文言で、読み上げにはこの領域で伝える -->
      <span class="visually-hidden" role="status">{waiting ? t('feedbackSending') : ''}</span>
    </form>
  {/if}
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form="{ids}-form" aria-disabled={waiting}
      >{waiting ? t('feedbackSending') : t('feedbackSend')}</button
    >
  {/snippet}
</Dialog>
