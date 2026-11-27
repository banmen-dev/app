<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation } from '../api.ts';
  import { FEEDBACK_TEXT_MAX, feedbackFailure, feedbackInput, validateFeedback } from '../feedback-form.ts';
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
  // 送っている間は欄を読むだけにし、送るボタンを止めて二重に送らない（開き直しても sending は残る）。
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
  let text = $state('');
  let error = $state<DictionaryKey | null>(null);
  let sending = $state(false);

  const max = FEEDBACK_TEXT_MAX.toLocaleString('ja-JP');

  function show(): void {
    error = null;
    dialog?.show(launcher);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    const invalid = validateFeedback(text);
    if (invalid !== null) {
      error = invalid;
      textarea?.focus();
      return;
    }
    sending = true;
    error = null;
    try {
      const result = await callOperation(feedbackSubmit, feedbackInput(text, page.route.id, window.location));
      if (result.ok) {
        open = false;
        text = '';
        error = null;
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
      if (open) {
        error = reason;
        textarea?.focus();
      } else {
        showToast(t('feedbackFailedClosed', { reason: t(reason, { max }) }), 'alert');
      }
    } finally {
      sending = false;
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
        bind:value={text}
        oninput={() => (error = null)}
        readonly={sending}
        aria-invalid={error !== null}
        aria-describedby="{publicId} {hintId}{error !== null ? ` ${errorId}` : ''}"></textarea>
      <p class="field-hint" id={hintId}>{t('feedbackHint', { max })}</p>
      {#if error !== null}<span class="field-error" id={errorId} role="alert"
          ><Icon name="alert" />{t(error, { max })}</span
        >{/if}
    </div>
    <!-- 送っている間は、目にはボタンの文言で、読み上げにはこの領域で伝える -->
    <span class="visually-hidden" role="status">{sending ? t('feedbackSending') : ''}</span>
  </form>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form="{ids}-form" aria-disabled={sending}
      >{sending ? t('feedbackSending') : t('feedbackSend')}</button
    >
  {/snippet}
</Dialog>
