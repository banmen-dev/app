<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { resolve } from '$app/paths';
  import Avatar from '../../../../../../lib/components/Avatar.svelte';
  import DefinitionChip from '../../../../../../lib/components/DefinitionChip.svelte';
  import DueChip from '../../../../../../lib/components/DueChip.svelte';
  import EmptyState from '../../../../../../lib/components/EmptyState.svelte';
  import FavoriteButton from '../../../../../../lib/components/FavoriteButton.svelte';
  import Icon from '../../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../../lib/components/LoadFailed.svelte';
  import Markdown from '../../../../../../lib/components/Markdown.svelte';
  import PageHead from '../../../../../../lib/components/PageHead.svelte';
  import Progress from '../../../../../../lib/components/Progress.svelte';
  import Section from '../../../../../../lib/components/Section.svelte';
  import { callOperation } from '../../../../../../lib/api.ts';
  import { focusPageHeading } from '../../../../../../lib/focus-heading.ts';
  import { isUnauthenticated, loginUrl } from '../../../../../../lib/login-redirect.ts';
  import { showToast } from '../../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../../lib/vocabulary.svelte.ts';
  import {
    epicClearConflictReasonOf,
    epicComplete,
    epicReopen,
  } from '../../../../../../shared/operations/epic/index.ts';
  import type { PageProps } from './$types';

  // エピックの画面（epic.html）。木のエピックの題から開く。概要（本文、リンク）、依頼主（離脱済みの人も、名前に「（離脱済み）」を添えて出す）、
  // 期日、区分、配下のストーリー（削除していないもの、並びの順。完了の印と、完了 / 全体のポイント）を出す。
  // 依頼主とリーダー（can_manage）には、概要の面の下に「<完了>にする」と「<完了>を取り消す」の面も出す（完了にできない理由は押せない操作の横に出し、
  // 配下のストーリーの完了から数える）。どちらも済んだらトーストで知らせる（演出は出さない）。
  // 添付ファイルは後の Issue で足す。
  // 見出しの横の「直す」は、エピックの引き出し（EpicDrawer。`?epic_id=<ID>`。ワークスペースの枠が置く）を開く。書き込めるときだけ出し、終了したワークスペースでは出さない
  // （引き出しの欄は、この画面がすべて読み取りで出している）。直したら画面の値を読み直し（引き出しが `app:epic-detail` を読み直す）、
  // 削除したか消えていたらバックログへ戻る（枠が戻す）。
  // 無いエピック（別の組織、別のワークスペース、削除済み）は「見つかりません」、読めなかったときは読み込みの失敗を出す。
  // 同じ画面の値を読み直している間は、本文の枠を aria-busy にする
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  // 直した後の読み直しに失敗しても（data.detail が null）、同じエピックの前に読めた値を残して知らせだけを出す。
  // 別のエピックへ移ったときは持ち越さない
  let kept = $state<{ id: string; detail: NonNullable<typeof data.detail> } | null>(null);
  $effect.pre(() => {
    if (data.detail !== null) kept = { id: page.params.epicId ?? '', detail: data.detail };
  });
  const detail = $derived(data.detail ?? (kept?.id === (page.params.epicId ?? '') ? kept.detail : null));
  const stale = $derived(data.detail === null && detail !== null && !data.notFound);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // 完了か取り消しの後に、この画面の値を読み直している間（invalidate は navigating を立てない）
  let refreshing = $state(false);
  const reloading = $derived(
    refreshing || (navigating.to !== null && navigating.to.url.pathname === page.url.pathname),
  );
  // 「<エピック>を直す」は、引き出しを開く（今の画面の上に `?epic_id=<ID>` を足す）
  const editHref = $derived(`${page.url.pathname}?epic_id=${encodeURIComponent(page.params.epicId ?? '')}`);
  const backlogHref = $derived(resolve('/[slug]/w/[id]', { slug, id: page.params.id ?? '' }));
  const finished = $derived(detail !== null && detail.epic.completed_at !== null);

  const pointsDone = $derived(detail?.stories.reduce((sum, story) => sum + story.points_done, 0) ?? 0);
  const pointsAll = $derived(detail?.stories.reduce((sum, story) => sum + story.points_all, 0) ?? 0);
  const tallies = $derived(
    detail === null
      ? []
      : [
          {
            icon: 'check' as const,
            label: t('epicPageTallyDone', { done: t('done'), points: t('points') }),
            count: pointsDone,
          },
          { label: t('epicPageTallyRemaining', { points: t('points') }), count: pointsAll - pointsDone },
        ],
  );

  // クリアか取り消しを送っている間。押しても無視する
  let clearBusy = $state(false);
  const showClear = $derived(canWrite && !finished && detail !== null && detail.can_manage);
  const showReopen = $derived(canWrite && detail !== null && detail.can_manage && detail.epic.completed_at !== null);
  const openStoryCount = $derived(detail?.stories.filter((story) => story.completed_at === null).length ?? 0);
  // クリアできない理由。配下が無い、未完了が残っている
  const clearBlocked = $derived(detail !== null && (detail.stories.length === 0 || openStoryCount > 0));

  // 完了か取り消しの後に、この画面の値だけを読み直す（枠は読み直さない）
  async function saved(): Promise<void> {
    refreshing = true;
    try {
      await invalidate('app:epic-detail');
    } finally {
      refreshing = false;
    }
  }

  // 完了と取り消し。済んだらトーストで知らせ、断られた理由ごとにも知らせ、どれも読み直す
  async function runClear(clearing: boolean, trigger: HTMLElement): Promise<void> {
    if (clearBusy || workspace === null || detail === null) return;
    const input = { workspace_id: workspace.id, epic_id: detail.epic.id };
    const words = {
      epic: t('epic'),
      story: t('story'),
      done: t('done'),
      workspace: t('workspace'),
      requester: t('requester'),
      leader: t('leader'),
    };
    clearBusy = true;
    let succeeded = false;
    try {
      const result = clearing
        ? await callOperation(epicComplete, input, { slug })
        : await callOperation(epicReopen, input, { slug });
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) {
        succeeded = true;
        showToast(t(clearing ? 'epicClearedToast' : 'epicReopened', words), 'check');
      } else {
        const reason = epicClearConflictReasonOf(result.error?.details);
        if (result.status === 403) {
          // 依頼主でもリーダーでもなくなった、またはワークスペースから外された。もう一度押しても直らないので、枠も読み直す
          showToast(t('epicClearForbidden', words), 'alert');
          await invalidate('app:workspace');
        } else if (result.error?.code === 'workspace_closed') {
          showToast(t('workspaceClosedReadOnly', words), 'alert');
          await invalidate('app:workspace');
        } else if (reason === 'open_stories') showToast(t('epicClearOpenStories', words), 'alert');
        else if (reason === 'empty') showToast(t('epicClearEmpty', words), 'alert');
        else if (reason === 'completed') showToast(t('epicClearAlready', words), 'alert');
        else if (reason === 'not_completed') showToast(t('epicNotCleared', words), 'alert');
        else if (reason === 'changed') showToast(t('epicClearChanged', words), 'alert');
        else if (result.status === 404) showToast(t('epicClearGone', words), 'alert');
        else showToast(t(clearing ? 'epicClearFailed' : 'epicReopenFailed', words), 'alert');
      }
      await saved();
    } finally {
      clearBusy = false;
    }
    await tick();
    // 済んだとき、または断られて読み直した結果、押した操作が反対の操作に入れ替わったとき（別の画面で先に完了や取り消しをした）は、
    // 面の見出しへ。完了と取り消しは同じ位置で入れ替わり、確認を挟まないので、押した続きのキーで反対の操作を送らないため。
    // 同じ操作が残っていればそこへ、面が消えていれば押したボタンか画面の見出しへ
    const same = document.querySelector<HTMLElement>(clearing ? '[data-epic-clear]' : '[data-epic-reopen]');
    const opposite = document.querySelector<HTMLElement>(clearing ? '[data-epic-reopen]' : '[data-epic-clear]');
    const heading = succeeded || opposite !== null ? document.querySelector<HTMLElement>('#epic-clear') : null;
    if (heading) heading.focus();
    else if (same) same.focus();
    else {
      if (trigger.isConnected) trigger.focus();
      else focusPageHeading();
    }
  }
</script>

<svelte:head>
  <!-- 読み込みに失敗した画面の題は LoadFailed が持つ -->
  {#if workspace && data.notFound}
    <title>{t('pageTitle', { page: t('epicPageNotFoundTitle', { epic: t('epic') }), app: t('appName') })}</title>
  {:else if workspace && detail !== null}
    <title>{t('pageTitle', { page: detail.epic.title, app: t('appName') })}</title>
  {/if}
</svelte:head>

{#snippet backLink()}
  <a class="btn is-sm is-quiet" href={backlogHref}>{t('epicPageBack', { backlog: t('backlog') })}</a>
{/snippet}

{#if workspace && data.notFound}
  <PageHead title={t('epicPageNotFoundTitle', { epic: t('epic') })} eyebrow={workspace.name} focusable />
  <EmptyState
    icon="search"
    title={t('epicPageNotFoundTitle', { epic: t('epic') })}
    text={t('epicPageNotFoundText', { workspace: t('workspace'), epic: t('epic') })}
  >
    {#snippet actions()}{@render backLink()}{/snippet}
  </EmptyState>
{:else if workspace && detail === null}
  <LoadFailed inShell />
{:else if workspace && detail !== null}
  {@const epic = detail.epic}
  {#snippet status()}
    {#if epic.completed_at !== null}
      <div><span class="chip is-done"><Icon name="check" />{t('epicCleared')}</span></div>
    {/if}
  {/snippet}
  {#snippet actions()}
    {@render backLink()}
    <FavoriteButton targetType="epic" targetId={epic.id} title={epic.title} workspaceId={workspace.id} />
    {#if canWrite}
      <!-- 引き出しはワークスペースの枠が置く（`?epic_id=<ID>`）。閉じたら、このリンクへフォーカスを戻す -->
      <!-- eslint-disable svelte/no-navigation-without-resolve -- href は resolve した経路に ?epic_id=<ID> を足したもの -->
      <a class="btn" href={editHref} data-epic-id={epic.id} data-sveltekit-reset="false">
        <Icon name="pen" />{t('epicPageEdit', { epic: t('epic') })}
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
  {/snippet}
  <PageHead
    title={epic.title}
    eyebrow={epic.category === null ? t('epic') : `${t('epic')}・${epic.category.name}`}
    {tallies}
    {actions}
    meta={epic.completed_at !== null ? status : undefined}
    focusable
  />

  {#if stale}
    <div class="callout is-warn">
      <Icon name="alert" /><span role="alert">{t('epicPageStale')}</span>
    </div>
  {/if}

  <div class="layout-aside" aria-busy={reloading}>
    <div class="layout-main">
      {#if epic.body_md !== null || epic.link_url !== null}
        <!-- 見える見出しは無いので、本文の見出し（h3 から）の前に h2 を置いて段を飛ばさない -->
        <section class="section" aria-labelledby="epic-overview">
          <h2 class="visually-hidden" id="epic-overview">{t('epicPageOverview', { epic: t('epic') })}</h2>
          {#if epic.body_md !== null}<Markdown source={epic.body_md} headingStart={3} />{/if}
          {#if epic.link_url !== null}
            <!-- URL は折り返して全文を出し、外のサイトは新しいタブで開く「開く」を横に置く（引き出しのリンクと同じ組み方）。
                 読み上げにも、新しいタブで開くことを含める -->
            <div class="form-actions">
              <span class="source-key is-wrap"><Icon name="link" /> {epic.link_url}</span>
              <a
                class="btn is-sm"
                href={epic.link_url}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={t('epicLinkOpenLabel')}>{t('epicLinkOpen')}</a
              >
            </div>
          {/if}
        </section>
      {/if}

      <Section id="epic-stories" title={t('epicPageStories', { story: t('story') })} count={detail.stories.length}>
        {#if detail.stories.length === 0}
          <EmptyState icon="flag" title={t('epicNoStories', { story: t('story') })} />
        {:else}
          {#each detail.stories as story (story.id)}
            <div class="story-block">
              <div class="story-head">
                <span class="kind is-story"><Icon name="check" /></span>
                <h3 class="story-title">{story.title}</h3>
                {#if story.completed_at !== null}
                  <span class="chip is-done"><Icon name="check" />{t('done')}</span>
                {/if}
                <Progress done={story.points_done} all={story.points_all} />
              </div>
            </div>
          {/each}
        {/if}
      </Section>
    </div>

    <aside class="layout-side is-static">
      <section class="panel" aria-labelledby="epic-request">
        <div class="panel-title"><h2 id="epic-request">{t('epicPageRequest')}</h2></div>
        <dl class="props">
          <div>
            <dt>{t('requester')}</dt>
            <dd>
              <Avatar
                userId={detail.requester.id}
                name={detail.requester.name}
                left={detail.requester.left}
                decorative
              />{detail.requester.name}{#if detail.requester.left}<span class="props-note">{t('leftMember')}</span>{/if}
            </dd>
          </div>
          <div>
            <dt>{t('due')}</dt>
            <dd>
              {#if epic.due_on !== null}
                <DueChip dueOn={epic.due_on} today={detail.today} weekStart={detail.week_start} done={finished} />
              {:else}
                <span class="props-note">—</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>{t('category')}</dt>
            <dd>
              {#if epic.category !== null}
                <DefinitionChip kind="category" name={epic.category.name} />
              {:else}
                <span class="props-note">{t('categoryNone', { category: t('category') })}</span>
              {/if}
            </dd>
          </div>
        </dl>
      </section>

      {#if showClear || showReopen}
        <section class="panel" aria-labelledby="epic-clear">
          <div class="panel-title">
            <h2 id="epic-clear" tabindex="-1">{t('epicClearPanel', { epic: t('epic'), done: t('done') })}</h2>
          </div>
          <p class="panel-note" id="epic-clear-note">
            {#if showReopen}
              {t('epicClearNoteCleared', { done: t('done') })}
            {:else if detail.stories.length === 0}
              {t('epicClearNoteEmpty', { story: t('story'), epic: t('epic'), done: t('done') })}
            {:else if openStoryCount > 0}
              {t('epicClearNoteOpen', { story: t('story'), count: openStoryCount, done: t('done') })}
            {:else}
              {t('epicClearNoteReady', { story: t('story'), done: t('done'), epic: t('epic') })}
            {/if}
          </p>
          <div class="actions-col">
            {#if showReopen}
              <button
                class="btn"
                type="button"
                data-epic-reopen
                aria-disabled={clearBusy}
                aria-describedby="epic-clear-note"
                onclick={(event) => void runClear(false, event.currentTarget)}
              >
                {t('epicReopen', { done: t('done') })}
              </button>
            {:else}
              <button
                class="btn is-primary"
                type="button"
                data-epic-clear
                aria-disabled={clearBusy || clearBlocked}
                aria-describedby="epic-clear-note"
                onclick={(event) => {
                  if (!clearBlocked) void runClear(true, event.currentTarget);
                }}
              >
                <Icon name="check" />{t('clear')}
              </button>
            {/if}
          </div>
          <span class="visually-hidden" role="status"
            >{clearBusy
              ? t(showReopen ? 'epicReopening' : 'epicClearing', { epic: t('epic'), done: t('done') })
              : ''}</span
          >
        </section>
      {/if}
    </aside>
  </div>
{/if}
