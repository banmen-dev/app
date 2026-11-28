<script lang="ts">
  import { resolve } from '$app/paths';
  import EmptyState from '../../../../lib/components/EmptyState.svelte';
  import Gate from '../../../../lib/components/Gate.svelte';
  import GateSheet from '../../../../lib/components/GateSheet.svelte';
  import Icon from '../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import { attachmentSize } from '../../../../lib/attachment-display.ts';
  import { formatDateTime } from '../../../../lib/format-datetime.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import { operationPath } from '../../../../shared/operations/define.ts';
  import { feedbackImageRef, operatorFeedbackImage } from '../../../../shared/operations/operator/index.ts';
  import type { PageProps } from './$types';

  // フィードバックの閲覧の画面。運用者だけが、利用者が自分で送った文、送った画面の URL と経路、アカウントの ID、画像を見る。
  // 文と URL は文字として出し（HTML にもリンクにもしない）、画像は <img> で描いてダウンロードの操作を添える。
  // 画像の応答は Content-Disposition: attachment のままで、<img> の読み込みには効かず、URL を直接開いたときだけ保存になる。
  // 一覧は持たない。Issue の本文のリンクから開く
  let { data }: PageProps = $props();
  const words = { organization: t('organization') };
  // 読み込めなかった画像の ID。その画像の場所だけを読み込めなかった旨に替え、ほかの画像と文はそのまま出す
  let failedImages = $state<readonly string[]>([]);
  const markFailed = (id: string) => {
    if (!failedImages.includes(id)) failedImages = [...failedImages, id];
  };
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageOperatorFeedback'), app: t('appName') })}</title>
</svelte:head>

{#if data.state === 'failed'}
  <LoadFailed />
{:else}
  <Gate wide>
    <GateSheet brand title={t('pageOperatorFeedback')}>
      {#if data.state === 'not-found'}
        <EmptyState icon="search" title={t('operatorFeedbackNotFoundTitle')} text={t('operatorFeedbackNotFoundText')}>
          {#snippet actions()}
            <a class="btn" href={resolve('/operator')}>{t('operatorOpen')}</a>
          {/snippet}
        </EmptyState>
      {:else}
        {@const feedback = data.feedback}
        <div class="callout is-info"><Icon name="shield" /><span>{t('operatorFeedbackNotice', words)}</span></div>
        <dl class="props">
          <div>
            <dt>{t('operatorFeedbackSubmittedAt')}</dt>
            <dd><span class="mono">{formatDateTime(feedback.submitted_at)}</span></dd>
          </div>
          <div>
            <dt>{t('operatorFeedbackAccount')}</dt>
            <dd><span class="mono">{feedback.account_id}</span></dd>
          </div>
          <div>
            <dt>{t('operatorFeedbackUrl')}</dt>
            <dd>
              {#if feedback.url === null}<span class="props-note">{t('operatorFeedbackUrlNone')}</span>{:else}<span
                  class="mono">{feedback.url}</span
                >{/if}
            </dd>
          </div>
          <div>
            <dt>{t('operatorFeedbackRoute')}</dt>
            <dd>
              {#if feedback.route_id === null}<span class="props-note">{t('operatorFeedbackRouteNone')}</span
                >{:else}<span class="mono">{feedback.route_id}</span>{/if}
            </dd>
          </div>
        </dl>
        <h2 class="dialog-title">{t('operatorFeedbackText')}</h2>
        <!-- 利用者の文はそのまま文字として出す（Markdown や HTML として解釈しない）。改行は残す -->
        <!-- 外側の div は、紙の直下の .doc-box の枠と余白を外す規則（.gate-sheet > .doc-box）に当たらないための包み。利用者の文を案内文と見分けるため枠を残す -->
        <div><div class="doc-box is-plain">{feedback.text}</div></div>
        <h2 class="dialog-title">{t('operatorFeedbackImages')}</h2>
        {#if feedback.images.length === 0}
          <p class="props-note">{t('operatorFeedbackImagesNone')}</p>
        {:else}
          {#each feedback.images as image, index (image.id)}
            {@const src = operationPath(operatorFeedbackImage, undefined, {
              id: feedbackImageRef(feedback.feedback_id, image.id),
            })}
            <!-- 失敗の文は onerror の後に差し込む。後から足した role="status" は読み上げられないことがあるので、
                 初めからある figure をライブ領域にし、差し込んだ文を伝える（画像が消えたことは伝えない） -->
            <figure class="md-figure" aria-live="polite">
              {#if failedImages.includes(image.id)}
                <p class="props-note">{t('operatorFeedbackImageFailed', { number: index + 1 })}</p>
              {:else}
                <div class="preview">
                  <img
                    {src}
                    decoding="async"
                    alt={t('operatorFeedbackImageAlt', { number: index + 1 })}
                    onerror={() => markFailed(image.id)}
                  />
                </div>
              {/if}
              <!-- eslint-disable svelte/no-navigation-without-resolve 画像の配信 URL は API の定義から作る -->
              <a class="btn" href={src} download
                ><Icon name="download" />{t('operatorFeedbackImageDownload', {
                  number: index + 1,
                  type: image.content_type,
                  size: attachmentSize(image.bytes),
                })}</a
              >
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            </figure>
          {/each}
        {/if}
      {/if}
    </GateSheet>
  </Gate>
{/if}
