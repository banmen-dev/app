<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation } from '../api.ts';
  import { taskDetailHref, taskLinkAttrs } from '../drawer.svelte.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import {
    RECENT_ACTIVITY_PANE_ID,
    activitySentence,
    appendEntries,
    formatActivityTime,
    groupByDay,
    targetQuery,
  } from '../recent-activity.ts';
  import { organizationLabel } from '../organization-label.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { recentActivity, type RecentActivityEntry } from '../../shared/operations/organization/recent-activity.ts';
  import { myRecentActivity } from '../../shared/operations/organization/my-recent-activity.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import EmptyState from './EmptyState.svelte';
  import Icon from './Icon.svelte';
  import Pane from './Pane.svelte';

  // kit.js の activity（最近の更新の面。組織のホームの右の列）。ホームの load には入れず、この面が開いたときに自分で読む
  // （今日やることの操作でホームを読み直しても、足した続きを消さず、ホーム全体の表示を待たせない）。新しい更新を自動では読み直さない。
  // 状態は、読み込み中（骨組み）、読めた（行か空の案内）、読めなかった（失敗の案内と「もう一度試す」）。続きの読み込みと失敗は、読めた状態の中で出す。
  // 読み込みの状態は、常に置いた role="status" の領域の文字だけを替えて伝える（LoadFailed と同じ）。
  // 行は押すと、対象のワークスペースのバックログに `?task=` `?story=` `?epic_id=` を付けて移り、詳細の引き出しが開く。
  // slug を渡さないときは、全組織のダッシュボード（/）の面として my-recent-activity を読み、各行に組織の名前（自分用は「自分用」）を添え、
  // 行の行き先はその行の組織にする。読めなかった組織と、上限を超えて読まなかった組織の数は、先頭のページの答えを面の上に出す
  type Organization = OutputOf<typeof myRecentActivity>['failed_organizations'][number];
  type Entry = RecentActivityEntry & { organization?: Organization };
  type Listing = { entries: Entry[]; next: OutputOf<typeof recentActivity>['next'] };
  // noWorkspace は、今所属する閉じていないワークスペースが無いこと（ホームの todayEmptyKind が 'noWorkspace'）。
  // 空の案内はワークスペースの面に出すので、ここは線画の無い短い1行にする。組織を読めなかったとき（unknown）は、今の空の案内のまま
  let { slug: slugProp, noWorkspace = false }: { slug?: string; noWorkspace?: boolean } = $props();
  // 親は `slug={data.slug}` で渡す。この prop の読み出しは data（ページの load の結果）を直に読むので、ホームを読み直して data が
  // 新しい値に置き換わるたびに、slug の値が同じでも effect が走り直す（今日やることの操作のたびに、足した続きを捨てて先頭から読み直していた）。
  // $derived にすると値の比較が入り、値が替わったとき（別の組織へ移ったとき）だけ、依存する effect が走り直る
  const slug = $derived(slugProp);

  let phase = $state<'loading' | 'ready' | 'failed'>('loading');
  let entries = $state.raw<Entry[]>([]);
  // 全組織の面だけ。先頭のページで読めなかった組織と、読まなかった組織の数
  let failedOrganizations = $state.raw<Organization[]>([]);
  let omittedOrganizations = $state(0);
  let next = $state.raw<Listing['next']>(null);
  // 「もう一度試す」で先頭を読み直している間と、読み直しがまた失敗したか
  let retrying = $state(false);
  let retryFailed = $state(false);
  let loadingMore = $state(false);
  let moreFailed = $state(false);
  // 読み込みの世代。組織が替わった（slug が替わった）後に戻った応答を捨てる
  let generation = 0;

  const days = $derived(groupByDay(entries));
  // 読み込みの状態の文。初回の読み込み中は骨組みだけ（Pane の aria-busy）で、文は空から始める
  // （LoadFailed と同じ。マウント時に文字を持った領域は読み上げられない恐れがあるため）。
  // 文を出すのは、続きの読み込み中、失敗の案内での読み直し中、また失敗したときだけ。
  // 失敗の案内の中では、ボタンの横に出す（見える文）。ほかの状態では、見えない領域に出す。どちらも、その状態の間は常に置き、文字だけを替える。
  // 失敗の案内の外で retrying を見ない（読み直しが成功した瞬間に、見えない領域へ「読み込んでいます」が入らないように）
  const failedStatus = $derived(
    phase === 'failed' ? (retrying ? t('retrying') : retryFailed ? t('retryFailed') : '') : '',
  );
  const hiddenStatus = $derived(phase !== 'failed' && loadingMore ? t('loading') : '');

  function toLogin(): void {
    window.location.assign(loginUrl(page.url));
  }

  // 1ページを読む。組織のホームは recent-activity、全組織の面は my-recent-activity
  async function fetchPage(before: Listing['next'] | undefined) {
    const input = before === undefined || before === null ? {} : { before };
    if (slug === undefined) return callOperation(myRecentActivity, input);
    const result = await callOperation(recentActivity, input, { slug });
    return result.ok
      ? { ...result, data: { ...result.data, failed_organizations: [], omitted_organizations: 0 } }
      : result;
  }

  // 先頭の 20 件を読む。読めたら、足した続きも失敗の知らせも捨てて置き直す
  async function loadFirst(): Promise<void> {
    const token = generation;
    const result = await fetchPage(undefined);
    if (token !== generation) return;
    if (isUnauthenticated(result)) {
      toLogin();
      return;
    }
    if (!result.ok) {
      phase = 'failed';
      return;
    }
    entries = result.data.entries;
    next = result.data.next;
    failedOrganizations = result.data.failed_organizations;
    omittedOrganizations = result.data.omitted_organizations;
    moreFailed = false;
    phase = 'ready';
  }

  $effect(() => {
    void slug;
    untrack(() => {
      generation++;
      phase = 'loading';
      entries = [];
      next = null;
      retrying = false;
      retryFailed = false;
      loadingMore = false;
      moreFailed = false;
      void loadFirst();
    });
    return () => {
      generation++;
    };
  });

  async function retry(): Promise<void> {
    if (retrying) return;
    const token = generation;
    // 押したときのフォーカス。読み直している間に、利用者が別の場所へ移したときは、その人のフォーカスを奪わない
    const focused = document.activeElement;
    retrying = true;
    retryFailed = false;
    try {
      await loadFirst();
    } finally {
      // 組織が替わった後に戻った古い読み直しは、新しい面の状態を書き換えない
      if (token === generation) {
        retrying = false;
        // 読み直しが終わっても失敗の案内が残っていれば、また失敗したということ（読めれば面ごと入れ替わる）
        if (phase === 'failed') retryFailed = true;
      }
    }
    // 読めたら、押したボタンが消えるので、フォーカスがそのボタンか body に残っているときだけ、先頭の行（空なら面の見出し）へ移す
    if (token === generation && phase === 'ready') {
      await tick();
      const now = document.activeElement;
      if (now !== focused && now !== document.body && now !== null) return;
      if (entries.length > 0) focusRow(entries[0]!.id);
      else document.getElementById(RECENT_ACTIVITY_PANE_ID)?.focus();
    }
  }

  function focusRow(id: string | undefined): void {
    if (id === undefined) return;
    document.querySelector<HTMLElement>(`[data-activity-id="${CSS.escape(id)}"]`)?.focus();
  }

  // 続きを読む。足した最初の行へフォーカスを移す（押したボタンは位置が下がるため）。足した行が無かったときは最後の行へ戻す
  async function loadMore(): Promise<void> {
    const before = next;
    if (loadingMore || before === null) return;
    const token = generation;
    loadingMore = true;
    moreFailed = false;
    try {
      const result = await fetchPage(before);
      if (token !== generation) return;
      if (isUnauthenticated(result)) {
        toLogin();
        return;
      }
      if (!result.ok) {
        moreFailed = true;
        return;
      }
      const shown = new Set(entries.map((entry) => entry.id));
      const added = result.data.entries.filter((entry) => !shown.has(entry.id));
      entries = appendEntries(entries, result.data.entries);
      next = result.data.next;
      await tick();
      focusRow(added[0]?.id ?? entries.at(-1)?.id);
    } finally {
      if (token === generation) loadingMore = false;
    }
  }

  // 行のリンク。タスクは引き出しの開き方（横、真ん中、ページ全体、新しいタブ）に従い、ストーリーとエピックは引き出しだけ。
  // 全組織の面（slug なし）の行は別の画面へ移るので、一覧の位置を保たない（taskLinkAttrs の preservePosition を偽にする。今日やることの面と同じ）
  function href(entry: Entry): string {
    const base = resolve('/[slug]/w/[id]', { slug: entry.organization?.slug ?? slug ?? '', id: entry.workspace.id });
    const link = `${base}${targetQuery(entry.target)}`;
    return entry.target.kind === 'task' ? taskDetailHref(link) : link;
  }
</script>

<Pane id={RECENT_ACTIVITY_PANE_ID} title={t('paneActivity')} busy={phase === 'loading'}>
  {#if phase !== 'failed'}<span class="visually-hidden" role="status">{hiddenStatus}</span>{/if}
  {#if phase === 'loading'}
    <div class="skeleton" aria-hidden="true">
      <span class="skeleton-line is-block"></span>
      <span class="skeleton-line is-block"></span>
      <span class="skeleton-line is-block"></span>
    </div>
  {:else if phase === 'failed'}
    <div class="callout is-warn"><Icon name="alert" /><span role="alert">{t('activityLoadFailed')}</span></div>
    <div class="form-actions activity-actions">
      <button class="btn" type="button" aria-disabled={retrying} onclick={() => void retry()}>{t('retry')}</button>
      <span class="field-hint" role="status">{failedStatus}</span>
    </div>
  {:else}
    {#if omittedOrganizations > 0}
      <div class="callout is-info">
        <Icon name="list-bullet" /><span>{t('activityOmitted', { count: omittedOrganizations })}</span>
      </div>
    {/if}
    {#if failedOrganizations.length > 0}
      <div class="choice-list">
        {#each failedOrganizations as organization (organization.slug)}
          <a class="choice" href={resolve('/[slug]', { slug: organization.slug })}>
            <div><b>{organizationLabel(organization)}</b><span>{t('activityFailedOrganization')}</span></div>
            <Icon name="chevron" />
          </a>
        {/each}
      </div>
    {/if}
    {@render listing()}
  {/if}
</Pane>

{#snippet listing()}
  {#if entries.length === 0 && noWorkspace}
    <!-- 所属が無い人には、案内をワークスペースの面に出す。ここは線画の無い短い1行にして、案内を重ねない -->
    <div class="book">
      <div class="book-empty">
        {t('activityEmptyNoWorkspaceText', {
          workspace: t('workspace'),
          task: t('task'),
          story: t('story'),
          epic: t('epic'),
        })}
      </div>
    </div>
  {:else if entries.length === 0 && failedOrganizations.length > 0}
    <!-- 全組織の面で、読めた組織に更新が無く、読めなかった組織がある。空の案内は出さない（読めなかった組織に更新があるかもしれない） -->
  {:else if entries.length === 0}
    <EmptyState
      icon="clock"
      art="notice"
      title={t('activityEmptyTitle')}
      text={t('activityEmptyText', { workspace: t('workspace'), task: t('task'), story: t('story'), epic: t('epic') })}
    />
  {:else}
    <div class="activity">
      {#each days as day (day.label)}
        <section class="activity-day">
          <h3 class="activity-date">{day.label}</h3>
          <ul class="activity-list">
            {#each day.entries as entry (entry.id)}
              <li>
                <!-- eslint-disable svelte/no-navigation-without-resolve -- href は resolve した経路に ?task=<ID>（か ?story=、?epic_id=）を足したもの、またはタスクの詳細ページ -->
                <a
                  class="activity-row"
                  href={href(entry)}
                  data-activity-id={entry.id}
                  {...entry.target.kind === 'task' ? taskLinkAttrs(slug !== undefined) : {}}
                >
                  <b class="activity-title">{entry.target.title}</b>
                  <span class="activity-text">{activitySentence(entry, t)}</span>
                  {#if entry.event.kind === 'comment' && entry.event.body !== ''}
                    <span class="activity-body">{entry.event.body}{entry.event.truncated ? '…' : ''}</span>
                  {/if}
                  <span class="activity-meta">
                    <span class="chip">{t(entry.target.kind)}</span>
                    {#if entry.organization !== undefined}
                      <span class="tag">{organizationLabel(entry.organization)}</span>
                    {/if}
                    <span class="tag">{entry.workspace.name}</span>
                    <time datetime={entry.created_at}>{formatActivityTime(entry.created_at)}</time>
                  </span>
                </a>
                <!-- eslint-enable svelte/no-navigation-without-resolve -->
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
    {#if moreFailed}
      <div class="callout is-warn"><Icon name="alert" /><span role="alert">{t('activityMoreFailed')}</span></div>
    {/if}
    {#if next !== null}
      <div class="form-actions activity-actions">
        <button class="btn" type="button" aria-disabled={loadingMore} onclick={() => void loadMore()}
          >{t('activityMore')}</button
        >
      </div>
    {/if}
  {/if}
{/snippet}
