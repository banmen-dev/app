<script lang="ts">
  import { tick } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation } from '../api.ts';
  import { taskDetailHref, taskLinkAttrs } from '../drawer.svelte.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { activitySentence, appendEntries, formatActivityTime, groupByDay, targetQuery } from '../recent-activity.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { recentActivity, type RecentActivityEntry } from '../../shared/operations/organization/recent-activity.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import EmptyState from './EmptyState.svelte';
  import Icon from './Icon.svelte';
  import Pane from './Pane.svelte';

  // kit.js の activity（最近の更新の面。組織のホームの右の列）。first は最初の 20 件（読めなかったときは null）。
  // 「さらに読む」は続きを足す。first が替わったとき（ホームの読み直し）は、足した続きを捨てて先頭から並べ直す。
  // 行は押すと、対象のワークスペースのバックログに `?task=` `?story=` `?epic_id=` を付けて移り、詳細の引き出しが開く
  type Listing = OutputOf<typeof recentActivity>;
  let { slug, first, onRetry }: { slug: string; first: Listing | null; onRetry: () => void } = $props();

  // 足した続き。source は、どの first に続けたか（first が替わっていたら使わない）。source を === で比べるので、
  // 深いリアクティブな値（プロキシ）にせず、そのまま持つ（$state.raw）
  let more = $state.raw<{ source: Listing | null; entries: RecentActivityEntry[]; next: Listing['next'] } | null>(null);
  let loading = $state(false);
  let moreFailed = $state(false);

  const current = $derived(more !== null && more.source === first ? more : null);
  const entries = $derived(appendEntries(first?.entries ?? [], current?.entries ?? []));
  const next = $derived(current !== null ? current.next : (first?.next ?? null));
  const days = $derived(groupByDay(entries));

  // 行のリンク。タスクは引き出しの開き方（横、真ん中、ページ全体、新しいタブ）に従い、ストーリーとエピックは引き出しだけ
  function href(entry: RecentActivityEntry): string {
    const base = resolve('/[slug]/w/[id]', { slug, id: entry.workspace.id });
    const link = `${base}${targetQuery(entry.target)}`;
    return entry.target.kind === 'task' ? taskDetailHref(link) : link;
  }

  async function loadMore(): Promise<void> {
    const before = next;
    if (loading || before === null) return;
    const source = first;
    loading = true;
    moreFailed = false;
    try {
      const result = await callOperation(recentActivity, { before }, { slug });
      // 読んでいる間にホームが読み直された（先頭が替わった）ときは、この続きを使わない
      if (source !== first) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (!result.ok) {
        moreFailed = true;
        return;
      }
      const shown = new Set(entries.map((entry) => entry.id));
      const added = result.data.entries.filter((entry) => !shown.has(entry.id));
      more = { source, entries: [...(current?.entries ?? []), ...added], next: result.data.next };
      // 押したボタンは位置が下がるので、足した最初の行へフォーカスを移す
      await tick();
      const firstAdded = added[0];
      if (firstAdded !== undefined) {
        document.querySelector<HTMLElement>(`[data-activity-id="${CSS.escape(firstAdded.id)}"]`)?.focus();
      }
    } finally {
      loading = false;
    }
  }
</script>

<Pane id="p-activity" title={t('paneActivity')}>
  {#if first === null}
    <div class="callout is-warn" role="alert">
      <Icon name="alert" /><span>{t('activityLoadFailed')}</span>
      <button class="btn is-sm" type="button" onclick={onRetry}>{t('retry')}</button>
    </div>
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
                  {...entry.target.kind === 'task' ? taskLinkAttrs() : {}}
                >
                  <b class="activity-title">{entry.target.title}</b>
                  <span class="activity-text">{activitySentence(entry, t)}</span>
                  {#if entry.event.kind === 'comment'}
                    <span class="activity-body">{entry.event.body}{entry.event.truncated ? '…' : ''}</span>
                  {/if}
                  <span class="activity-meta">
                    <span class="chip">{t(entry.target.kind)}</span>
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
      <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{t('activityMoreFailed')}</span></div>
    {/if}
    {#if next !== null}
      <div class="form-actions">
        <button class="btn is-sm" type="button" aria-disabled={loading} onclick={() => void loadMore()}
          >{t('activityMore')}</button
        >
      </div>
    {/if}
  {/if}
</Pane>
