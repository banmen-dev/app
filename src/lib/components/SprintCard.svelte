<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { SprintBoardTask } from '../../shared/operations/sprint/index.ts';
  import { taskDetailHref, taskLinkAttrs } from '../drawer.svelte.ts';
  import type { MoveDirection } from '../sprint-board.ts';
  import type { SprintDnd } from '../sprint-dnd.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import RowMenu, { type RowMenuItem } from './RowMenu.svelte';

  // ボードの画面のカード（kit.js の card）。上に題（`?task=<ID>` で詳細の引き出しを開くリンク）、次に期日などの印、
  // 下の段の左に親のストーリー（押すと絞り込む）、右にポイント、担当、完了したカードの完了の印（#1498。並びは Jira のカードからキーを除いたもの）。
  // 書き込めるカードは完了したものも tabindex="0" で選べる。未完了カードは中のどこにフォーカスがあっても Alt と ← → で隣の列、
  // Alt と ↑ ↓ で列の中を動かす。同じ操作を、カードの右下の「⋯」（RowMenu）のメニューの「前の<列>へ」「上へ」「下へ」「次の<列>へ」でもできる。
  // 完了していないカードの操作は、「⋯」だけを出す。端の項目は aria-disabled（フォーカスを失わない）にし、端で Alt と矢印を押したときは画面に渡し、動かせないことを読み上げさせる。
  // 最後の完了でない列の「次の列へ」と Alt と → は、画面が完了にする（task-complete）。
  // 完了したカードも選べ、Alt と ← と「⋯」の前の列へで完了を戻す。戻せないカードも試せ、画面が理由を知らせる。
  // dnd を渡すと（書き込めるとき）、完了したカードを含めカード全体をつかめる。戻せないカードは not-allowed のカーソルで示す。
  // 題のリンクは draggable="false" で、リンクの既定のドラッグがカードのドラッグを奪わない。ボタンと「⋯」は押すだけで動き出さない。
  // 落とす位置の印は data-drop、つかんだ薄さは .is-dragging、落とした光は .is-dropped
  let {
    task,
    href,
    edges,
    writable = false,
    clock,
    hintId,
    dnd,
    onmove,
    ondelete,
    highlightedStory = null,
    onstoryhover,
    onstoryfocus,
    onstoryfilter,
  }: {
    highlightedStory?: string | null;
    // ポインタが乗ったカードのストーリー（親のないカードは null）。undefined はカードの上にいないことで、フォーカスの強調に戻す
    onstoryhover?: (id: string | null | undefined) => void;
    onstoryfocus?: (id: string | null) => void;
    onstoryfilter?: (id: string) => void;
    task: SprintBoardTask;
    href: string;
    // ドラッグの配線。書き込めないときは渡さず、つかめず落とし先にもならない
    dnd?: SprintDnd;
    // 動かし方の見えない説明の id。選んだカードの説明に結ぶ
    hintId?: string;
    // 期日の印を決める今日（ワークスペースのタイムゾーン）と週の始まり。API の値を渡す
    clock: { today: string; weekStart: number };
    // 動かせないカード（完了の列、書き込めない）は null
    // completes は、次の列が完了の列で「次の列へ」が完了にすること（読み上げの名前と title を完了の操作の名前にする）
    edges: { top: boolean; bottom: boolean; prev: boolean; next: boolean; completes: boolean } | null;
    // 完了カードも選び、戻す操作を試せるか（書き込めるときだけ）
    writable?: boolean;
    onmove: (task: SprintBoardTask, direction: MoveDirection, repeat?: boolean) => void;
    // 渡すと（書き込めるとき）、task.can_delete が真のカードの「⋯」の末尾に危険色の「この<タスク>を削除する」を出す
    ondelete?: (task: SprintBoardTask, keyboard: boolean) => void;
  } = $props();

  const done = $derived(task.completed_at !== null);
  // 乗っている間に消えたカード（削除、列をまたぐ移動）は pointerleave が来ないので、破棄するときに強調を外す
  let hovering = false;
  function storyPointerEnter(event: PointerEvent): void {
    // タッチは押すだけで入るため、強調しない（スクロールのたびにほかのカードが暗くなる）
    if (event.pointerType === 'touch') return;
    hovering = true;
    onstoryhover?.(task.story?.id ?? null);
  }
  onDestroy(() => {
    if (hovering) onstoryhover?.(undefined);
  });
  const movable = $derived(edges !== null);
  const selectable = $derived(movable || (done && writable));
  const column = $derived(t('column'));
  // 末尾の危険色の項目。確認は挟まない（消したらトーストの「取り消す」で戻せる）。動かせるカード（完了していない）だけに出す
  // （見本の kit.js の card と同じ。完了したカードは、消して取り消しても完了のポイントがそのスプリントに戻らないため）
  const deleteItems = $derived<RowMenuItem[]>(
    ondelete !== undefined && task.can_delete && movable
      ? [
          {
            key: 'delete',
            label: t('taskDelete', { task: t('task') }),
            icon: 'trash',
            danger: true,
            onselect: (_trigger, keyboard) => ondelete(task, keyboard),
          },
        ]
      : [],
  );
  // 「⋯」のメニューの項目（kit.js の orderItems の順）。最後の完了でない列の「次の列へ」は完了にするので、名前もそう言う
  const moveItems = $derived<RowMenuItem[]>(
    done && writable
      ? [
          {
            key: 'left',
            label: t('moveColumnReopen', { column, done: t('done') }),
            icon: 'left',
            onselect: () => onmove(task, 'left'),
          },
        ]
      : edges === null
        ? []
        : [
            {
              key: 'left',
              label: t('moveColumnPrev', { column }),
              icon: 'left',
              disabled: edges.prev,
              onselect: () => onmove(task, 'left'),
            },
            { key: 'up', label: t('moveUp'), icon: 'up', disabled: edges.top, onselect: () => onmove(task, 'up') },
            {
              key: 'down',
              label: t('moveDown'),
              icon: 'down',
              disabled: edges.bottom,
              onselect: () => onmove(task, 'down'),
            },
            {
              key: 'right',
              label: edges.completes
                ? t('moveColumnComplete', { done: t('done'), column, complete: t('complete') })
                : t('moveColumnNext', { column }),
              icon: 'right',
              // 完了か戻しを送っている間も選べる。画面が捨てて理由を読み上げる（Alt と → と同じ。refusedWhileBusy）
              disabled: edges.next,
              onselect: () => onmove(task, 'right'),
            },
          ],
  );
  const menuItems = $derived<RowMenuItem[]>([...moveItems, ...deleteItems]);
  // 書き込めるときは、戻せない完了カードも試せるようにつかめる
  const grabbable = $derived(selectable);
  const KEY_DIRECTIONS: Record<string, MoveDirection> = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  };

  function keydown(event: KeyboardEvent): void {
    if (!selectable || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const direction = KEY_DIRECTIONS[event.key];
    if (direction === undefined || (done && direction !== 'left')) return;
    if (done && event.repeat) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    // 押しっぱなしの自動の繰り返しでは、完了の列の手前から完了にしない（列を送るうちに気づかず完了にしないため）
    if (event.repeat && direction === 'right' && edges?.completes === true) return;
    onmove(task, direction, event.repeat);
  }

  const titleId = $derived(`card-${task.id}-title`);
  const summaryId = $derived(`card-${task.id}-summary`);
  const pointsText = $derived(
    task.points === null ? t('pointsUnsetTitle') : t('pointsLabel', { points: t('points'), value: task.points }),
  );
  const baseSummary = $derived(
    task.assignee === null
      ? t('sprintCardSummaryUnassigned', { points: pointsText, unassigned: t('unassigned') })
      : t('sprintCardSummary', { points: pointsText, assignee: t('assignee'), name: task.assignee.name }),
  );
  const summary = $derived(
    done && !task.reopenable
      ? t('sprintCardReopenBlockedSummary', { summary: baseSummary, done: t('done') })
      : baseSummary,
  );
</script>

<!-- キーは中のリンクとボタンから届く。書き込めるカードは完了カードも選べる（tabindex は 0 か未指定だけ） -->
<!-- 選んだときは題を名前に、ポイントと担当の要約と動かし方の見えない説明を読む（中の印は role="img" で、選んだだけでは読まれないため） -->
<!-- 同じストーリーの強調は、親の名前の1行だけでなくカードのどこにポインタが乗っても働かせる（狭い行だけでは強調がちらつき、追いにくい）。外すのは盤の側（カードの隙間では保つ） -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
  class="card"
  class:is-done={done}
  class:is-story-highlighted={highlightedStory !== null && task.story?.id === highlightedStory}
  class:is-story-dimmed={highlightedStory !== null && task.story?.id !== highlightedStory}
  class:is-reopen-blocked={done && writable && !task.reopenable}
  class:is-dragging={dnd?.isDragging(task.id)}
  class:is-dropped={dnd?.isFlashing(task.id)}
  class:is-busy={dnd?.isBusy(task.id)}
  aria-busy={dnd?.isBusy(task.id) ? true : undefined}
  data-drop={dnd?.markOfCard(task.id)}
  {@attach dnd?.card(task.id, grabbable)}
  tabindex={selectable ? 0 : undefined}
  aria-labelledby={selectable ? titleId : undefined}
  aria-describedby={selectable ? [summaryId, hintId].filter(Boolean).join(' ') : undefined}
  data-card-id={task.id}
  onpointerenter={storyPointerEnter}
  onpointerleave={() => (hovering = false)}
  onkeydown={keydown}
>
  {#if selectable}<span class="visually-hidden" id={summaryId}>{summary}</span>{/if}
  <!-- 横と真ん中のときは、押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す）。ページ全体の既定では taskLinkAttrs が reset を外し、先頭から表示する -->
  <!-- eslint-disable svelte/no-navigation-without-resolve -- href は画面が resolve した経路に ?task=<ID> を足したもの、またはその詳細ページ -->
  <a
    class="card-title"
    id={titleId}
    href={taskDetailHref(href)}
    data-task-id={task.id}
    {...taskLinkAttrs()}
    draggable="false">{task.title}</a
  >
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {#if task.repository !== null || task.due_on !== null}
    <div class="card-meta">
      {#if task.repository !== null}<DefinitionChip kind="repository" name={task.repository.name} />{/if}
      {#if task.due_on !== null}
        <DueChip dueOn={task.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
      {/if}
    </div>
  {/if}
  <div class="card-foot">
    {#if task.story !== null}
      <button
        class="card-parent is-action"
        data-story-filter={task.story.id}
        type="button"
        aria-label={t('sprintStoryFilterLabel', { story: t('story'), title: task.story.title })}
        title={task.story.title}
        onfocus={() => onstoryfocus?.(task.story!.id)}
        onblur={() => onstoryfocus?.(null)}
        onclick={() => onstoryfilter?.(task.story!.id)}><Icon name="flag" /> {task.story.title}</button
      >
    {/if}
    <span class="card-end">
      {#if task.points === null}
        <span class="pts is-none" role="img" aria-label={t('pointsUnsetTitle')} title={t('pointsUnsetTitle')}
          >{t('pointsUnsetMark')}</span
        >
      {:else}
        <span
          class="pts"
          role="img"
          aria-label={t('pointsLabel', { points: t('points'), value: task.points })}
          title={t('pointsLabel', { points: t('points'), value: task.points })}>{task.points}</span
        >
      {/if}
      {#if task.assignee === null}
        <Avatar userId={null} />
      {:else}
        <Avatar userId={task.assignee.id} name={task.assignee.name} />
      {/if}
      {#if menuItems.length > 0}<RowMenu title={task.title} items={menuItems} />{/if}
      {#if done}
        <span class="hanko" role="img" aria-label={t('doneMarkLabel', { title: task.title, done: t('done') })}
          ><Icon name="check" /></span
        >
      {/if}
    </span>
  </div>
</article>
