<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import type { NewsItem } from '../news.ts';
  import Icon from './Icon.svelte';
  import Pane from './Pane.svelte';

  // 組織のホームの「Scrum Guild のニュース」の面（kit.js の newsList）。items は新しい順に絞った一覧（latestNews）。
  // 日付は暦の日付（YYYY-MM-DD）のまま出し、題と本文は書いたまま出す。リンクのある題は新しいタブで開き、external の印を添える。
  // 一覧が空のときは面ごと置かない
  let { items }: { items: readonly NewsItem[] } = $props();
</script>

{#if items.length > 0}
  <Pane id="p-news" title={t('paneNews')}>
    <ul class="news-list">
      {#each items as item (item.date + item.title)}
        <li class="news-item">
          <time class="news-date" datetime={item.date}>{item.date}</time>
          {#if item.href}
            <a class="news-title news-link" href={item.href} target="_blank" rel="external noopener noreferrer"
              ><span>{item.title}</span><Icon name="external" /><span class="visually-hidden">
                {t('markdownNewTab')}</span
              ></a
            >
          {:else}
            <b class="news-title">{item.title}</b>
          {/if}
          <p class="news-body">{item.body}</p>
        </li>
      {/each}
    </ul>
  </Pane>
{/if}
