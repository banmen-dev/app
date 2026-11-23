<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import {
    BOARD_FILTER_NONE,
    BOARD_GROUPS,
    boardGroupOf,
    BOARD_QUERY_MAX_LENGTH,
    clampQuery,
    isBoardFiltering,
    selectedCount,
    toggleBoardFilter,
    type BoardChoices,
    type BoardFilter,
    type BoardFilterKey,
  } from '../board-filter.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import Popover from './Popover.svelte';

  // ボードの道具の帯（design/sprint.html の .board-toolbar。#1502）。左に絞り込み（role="search"）として、検索の欄、
  // 担当のアバター、フィルターの小窓（ストーリー、エピック、担当、区分のチェック）と「すべてクリア」を並べ、右端（end）に
  // スプリントのボタンを置く。絞っている間は、帯の下に条件と表示している件数を出す。
  // filter は URL から読んだ絞り込み。値を変えると onchange に次の絞り込みを渡し、画面が URL を書き換える。
  // アバターとチェックはすぐ、検索は入力が 300ms 止まってから（Enter ならすぐ）渡す。IME で変換している間は渡さない。
  // アバターは名前の順に先頭の MAX_AVATARS 人と「担当なし」を出し、残りの人はフィルターの小窓から選ぶ。
  // アバターとフィルターの担当は同じ条件で、どちらで選んでも両方に映る
  let {
    filter,
    choices,
    shown,
    total,
    onchange,
    onclear,
    end,
  }: {
    filter: BoardFilter;
    choices: BoardChoices;
    // 絞った後に見えているカードの数と、ボードの全部のカードの数
    shown: number;
    total: number;
    onchange: (next: BoardFilter) => void;
    // 「すべてクリア」。外した後のフォーカスは画面が決める
    onclear: () => void;
    end: Snippet;
  } = $props();

  const MAX_AVATARS = 5;
  const SEARCH_DELAY_MS = 300;

  // 帯が最後に送った検索の語。URL の値（filter.q）が替わったとき、送った値と同じなら打ち足した文字を消さない
  let lastSent = untrack(() => filter.q);
  let text = $state(untrack(() => filter.q));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;
  $effect.pre(() => {
    const loaded = filter.q;
    untrack(() => {
      if (loaded === lastSent) return;
      clearTimeout(timer);
      timer = undefined;
      lastSent = loaded;
      text = loaded;
    });
  });
  $effect(() => () => clearTimeout(timer));

  function sendSearch(): void {
    clearTimeout(timer);
    timer = undefined;
    const q = clampQuery(text);
    if (q === filter.q) return;
    lastSent = q;
    onchange({ ...filter, q });
  }

  function searchInput(event: Event): void {
    clearTimeout(timer);
    timer = undefined;
    if (composing || (event instanceof InputEvent && event.isComposing)) return;
    timer = setTimeout(sendSearch, SEARCH_DELAY_MS);
  }

  function searchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    sendSearch();
  }

  let searchInputEl = $state<HTMLInputElement>();
  export function focusSearch(): void {
    searchInputEl?.focus();
  }

  function clear(): void {
    clearTimeout(timer);
    timer = undefined;
    text = '';
    lastSent = '';
    onclear();
  }

  function toggle(key: BoardFilterKey, value: string): void {
    onchange(toggleBoardFilter(filter, key, value));
  }

  const count = $derived(selectedCount(filter));
  const filtering = $derived(isBoardFiltering(filter) || text.trim() !== '');
  const named = $derived(choices.assignee.filter((choice) => choice.id !== BOARD_FILTER_NONE));
  // 先頭の人に加え、フィルターの小窓で選んだ先頭の外の人も並べる（選んだことがアバターにも映る）
  const avatars = $derived(named.filter((choice, index) => index < MAX_AVATARS || filter.assignee.includes(choice.id)));
  const hasUnassigned = $derived(choices.assignee.some((choice) => choice.id === BOARD_FILTER_NONE));

  const labels = $derived<Record<BoardFilterKey, string>>({
    story: t('story'),
    epic: t('epic'),
    assignee: t('assignee'),
    category: t('category'),
  });
  const noneLabels = $derived<Record<BoardFilterKey, string>>({
    story: t('boardFilterNoStory', { story: t('story') }),
    epic: t('filterNoEpic', { epic: t('epic') }),
    assignee: t('unassigned'),
    category: t('categoryNone', { category: t('category') }),
  });
  // 小窓の並び（Issue の順）。選べる値が無い条件は出さない
  const groups = $derived(
    (['story', 'epic', 'assignee', 'category'] as const)
      .map((key) => ({ key, choices: choices[key] }))
      .filter((group) => group.choices.length > 0),
  );

  function nameOf(key: BoardFilterKey, value: string): string | undefined {
    if (value === BOARD_FILTER_NONE) return noneLabels[key];
    return choices[key].find((choice) => choice.id === value)?.label;
  }

  // 帯の下の条件。検索の語、ストーリー、エピック、担当、区分の順。今のボードに無い値（すぐ URL から外す）は出さず、
  // 出す値が無い条件も出さない
  const conditions = $derived([
    ...(filter.q === '' ? [] : [t('boardFilterSearchCondition', { q: filter.q })]),
    ...(['story', 'epic', 'assignee', 'category'] as const).flatMap((key) => {
      const names = filter[key].map((value) => nameOf(key, value)).filter((name) => name !== undefined);
      return names.length === 0 ? [] : [t('boardFilterCondition', { label: labels[key], values: names.join('、') })];
    }),
  ]);
</script>

<div class="toolbar board-toolbar">
  <div class="board-filter" role="search" aria-label={t('boardFilterLabel', { board: t('board') })}>
    <label class="search">
      <Icon name="search" />
      <input
        type="search"
        bind:this={searchInputEl}
        bind:value={text}
        maxlength={BOARD_QUERY_MAX_LENGTH}
        placeholder={t('boardSearch', { board: t('board') })}
        aria-label={t('boardSearch', { board: t('board') })}
        oninput={searchInput}
        oncompositionstart={() => {
          composing = true;
          clearTimeout(timer);
          timer = undefined;
        }}
        oncompositionend={(event) => {
          composing = false;
          searchInput(event);
        }}
        onkeydown={searchKeydown}
      />
    </label>
    {#if avatars.length > 0 || hasUnassigned}
      <div class="avatar-filter" role="group" aria-label={t('boardAssigneeGroup', { assignee: t('assignee') })}>
        {#each avatars as person (person.id)}
          <button
            class="avatar-filter-btn"
            type="button"
            aria-pressed={filter.assignee.includes(person.id)}
            aria-label={person.label}
            title={person.label}
            onclick={() => toggle('assignee', person.id)}
            ><Avatar userId={person.id} name={person.label} decorative /></button
          >
        {/each}
        {#if hasUnassigned}
          <button
            class="avatar-filter-btn"
            type="button"
            aria-pressed={filter.assignee.includes(BOARD_FILTER_NONE)}
            aria-label={t('unassigned')}
            title={t('unassigned')}
            onclick={() => toggle('assignee', BOARD_FILTER_NONE)}><Avatar userId={null} decorative /></button
          >
        {/if}
        {#if named.length > avatars.length}
          <span class="avatar-filter-more" title={t('boardAssigneeMore', { count: named.length - avatars.length })}
            ><span aria-hidden="true">+{named.length - avatars.length}</span><span class="visually-hidden"
              >{t('boardAssigneeMore', { count: named.length - avatars.length })}</span
            ></span
          >
        {/if}
      </div>
    {/if}
    <Popover
      text={count > 0 ? t('boardFiltersCount', { count }) : t('boardFilters')}
      label={count > 0 ? t('boardFiltersLabel', { count }) : t('boardFilters')}
      dialogLabel={t('boardFilterDialog', { board: t('board') })}
      icon="filter"
      align="start"
      active={count > 0}
    >
      {#if groups.length === 0}
        <p class="popover-text">{t('boardFilterNoChoices')}</p>
      {:else}
        <div class="filter-groups">
          {#each groups as group (group.key)}
            <fieldset class="filter-group">
              <legend class="popover-label">{labels[group.key]}</legend>
              {#each group.choices as choice (choice.id)}
                <label class="filter-option">
                  <input
                    type="checkbox"
                    checked={filter[group.key].includes(choice.id)}
                    onchange={() => toggle(group.key, choice.id)}
                  />
                  <span class="filter-option-text"
                    >{choice.id === BOARD_FILTER_NONE ? noneLabels[group.key] : choice.label}</span
                  >
                  <span class="filter-option-n"
                    ><span aria-hidden="true">{choice.count}</span><span class="visually-hidden"
                      >{t('boardFilterOptionCount', { count: choice.count })}</span
                    ></span
                  >
                </label>
              {/each}
            </fieldset>
          {/each}
        </div>
      {/if}
    </Popover>
    <label class="board-group">
      {t('boardGroup')}
      <select
        class="input"
        value={filter.group ?? ''}
        onchange={(event) => onchange({ ...filter, group: boardGroupOf(event.currentTarget.value) })}
      >
        <option value="">{t('boardGroupNone')}</option>
        {#each BOARD_GROUPS as group (group)}
          <option value={group}>{group === 'assignee' ? t('boardGroupAssignee') : labels[group]}</option>
        {/each}
      </select>
    </label>
    {#if filtering}
      <button class="btn is-sm is-quiet" type="button" onclick={clear}
        ><Icon name="x" />{t('boardFilterClearAll')}</button
      >
    {/if}
  </div>
  <div class="toolbar-end">{@render end()}</div>
  {#if isBoardFiltering(filter)}
    <p class="toolbar-note board-filter-summary">
      {#each conditions as condition, index (index)}<b>{condition}</b>{/each}
      <span>{t('boardFilterShown', { total, shown })}</span>
      <span>{t('sprintStoryTotalsNote', { sprint: t('sprint'), points: t('points') })}</span>
    </p>
  {/if}
</div>
