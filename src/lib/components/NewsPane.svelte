<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import { isNewsHref, type NewsItem } from '../news.ts';
  import Icon from './Icon.svelte';
  import Pane from './Pane.svelte';

  // 組織のホームの「Scrum Guild のニュース」の面（kit.js の newsList）。items は新しい順に絞った一覧（latestNews）。
  // 日付は暦の日付（YYYY-MM-DD）のまま出し、題と本文は書いたまま出す。リンクのある題（h3 の中の a）は新しいタブで開き、題の文字の末尾に external の印を添える。
  // リンクにするのは isNewsHref を通るものだけ（通らなければ題だけを出す）。
  // 一覧が空のときは面ごと置かない
  let { items }: { items: readonly NewsItem[] } = $props();
</script>

{#if items.length > 0}
  <Pane id="p-news" title={t('paneNews', { app: t('appName') })}>
    <ul class="news-list">
      {#each items as item (item.date + item.title)}
        <li class="news-item">
          <time class="news-date" datetime={item.date}>{item.date}</time>
          <h3 class="news-title">
            {#if item.href !== undefined && isNewsHref(item.href)}
              <a class="news-link" href={item.href} target="_blank" rel="external noopener noreferrer"
                ><span>{item.title}<Icon name="external" /></span><span class="visually-hidden">
                  {t('markdownNewTab')}</span
                ></a
              >
            {:else}
              {item.title}
            {/if}
          </h3>
          <p class="news-body">{item.body}</p>
        </li>
      {/each}
    </ul>
  </Pane>
{/if}
