<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { useShortcut } from '../../../../../lib/shortcuts.svelte.ts';
  import { ariaKeyshortcuts, NEW_TASK_KEY } from '../../../../../lib/shortcut-keys.ts';
  import { goto, invalidate, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../../../../../lib/api.ts';
  import DraftAttrs from '../../../../../lib/components/DraftAttrs.svelte';
  import DraftRow, { DraftRowState } from '../../../../../lib/components/DraftRow.svelte';
  import BoardFilterBar from '../../../../../lib/components/BoardFilterBar.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import Markdown from '../../../../../lib/components/Markdown.svelte';
  import Progress from '../../../../../lib/components/Progress.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import Popover from '../../../../../lib/components/Popover.svelte';
  import SprintCard from '../../../../../lib/components/SprintCard.svelte';
  import SprintDialog from '../../../../../lib/components/SprintDialog.svelte';
  import SprintExtendDialog from '../../../../../lib/components/SprintExtendDialog.svelte';
  import SprintCloseDialog from '../../../../../lib/components/SprintCloseDialog.svelte';
  import SprintOverdueNotice from '../../../../../lib/components/SprintOverdueNotice.svelte';
  import { focusPageHeading } from '../../../../../lib/focus-heading.ts';
  import { focusRestored, focusSkipped, removeFromList } from '../../../../../lib/task-removal.ts';
  import {
    clearReloadFailure,
    markReloadFailed,
    reloadFailureNote,
    throwIfListFailed,
  } from '../../../../../lib/task-reload-failure.svelte.ts';
  import { MoveQueue } from '../../../../../lib/move-queue.ts';
  import { ReopenKeyGuard } from '../../../../../lib/reopen-key.ts';
  import { edgesOf, planCardMove, type MoveDirection, type MoveEdge } from '../../../../../lib/sprint-board.ts';
  import { boardLanesOf } from '../../../../../lib/board-lanes.ts';
  import {
    applyFilteredMove,
    BOARD_FILTER_NONE,
    boardFilterValue,
    boardChoicesOf,
    boardFilterHref,
    boardFilterOf,
    boardFilterQuery,
    cardMatches,
    emptyBoardFilter,
    filterColumns,
    isBoardFiltering,
    prunedBoardFilter,
    sameBoardFilter,
    storyForCreate,
    type BoardFilter,
  } from '../../../../../lib/board-filter.ts';
  import { SprintColumnCollapse } from '../../../../../lib/sprint-column-collapse.svelte.ts';
  import { SprintDnd } from '../../../../../lib/sprint-dnd.svelte.ts';
  import type { MovedPlan, ReopenPlan, SprintDrop } from '../../../../../lib/sprint-drop.ts';
  import { completedMessage, sprintLabel, sprintPeriod } from '../../../../../lib/sprint-label.ts';
  import { taskAttributes } from '../../../../../lib/task-attributes.svelte.ts';
  import { trackTaskOrder } from '../../../../../lib/task-order.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    columnMoveConflictReasonOf,
    taskColumnMove,
    type SprintBoardColumn,
    type SprintBoardTask,
  } from '../../../../../shared/operations/sprint/index.ts';
  import {
    taskAssign,
    taskComplete,
    taskCreate,
    taskCreateConflictReasonOf,
    taskReopen,
    taskReopenConflictReasonOf,
  } from '../../../../../shared/operations/task/index.ts';
  import { sprintProgress } from '../../../../../shared/sprint.ts';
  import { TASK_TITLE_MAX_LENGTH, taskTitleProblem } from '../../../../../shared/task.ts';
  import type { PageProps } from './$types';

  // ボードの画面（design/sprint.html。#1497 で /sprint から /board に改めた）。進行中のスプリントの列（`.board-col`）とカード（`.card`）を並べる。
  // 見出しは「ボード」だけで、その下の1段の道具の帯の右端に、スプリントの名前（無ければ期間）のボタン（Popover）を置く（#1498）。
  // 押すと開く小窓に、期間と何日目か、延長した日数、進み具合、残りの日数、ゴールと、リーダーの操作（編集、延長、終了）を出す。
  // カードは題（`?task=<ID>` で詳細の引き出しを開く）、期日、下の段に親のストーリー、ポイント、担当と、完了の印か列移動の「⋯」。
  // 完了の操作は task-complete を呼ぶだけで、完了の列への移動は task-complete が行う（完了の列へ task-column-move で移すことはしない）。
  // 動かせるカード（完了していない、終了していないワークスペース）は、選んで Alt と ← → で隣の列、Alt と ↑ ↓ で列の中を動かし、
  // カードの右下の「⋯」のメニューでも同じことができる。動かしたら先に画面の並びを替えて位置を読み上げ、押した順に1つずつ送る（MoveQueue）。
  // 最後の完了でない列の「次の列へ」と Alt と → は、完了の操作と同じく task-complete を呼ぶ。
  // 完了の列のカードは Alt と ← と「⋯」で戻す。戻せないカードを試すと既存の理由をトーストで読み上げ、書き込みは送らない。
  // 戻したら読み直して、戻した列のカードへフォーカスを移す。完了の列には、ワークスペースの完成の定義（空なら出さない）を畳んで置く。
  // 断られたら理由をトーストで知らせて読み直す。
  // カードのドラッグ（SprintDnd。判定は sprint-drop.ts）は、カード全体をつかみ、カードの間の線か列の囲みに落として動かす。
  // 列の中と別の列へは、ボタンと同じ流れ（先に画面の並びを替え、読み上げ、MoveQueue に積んで task-column-move）。
  // 完了の列へ落としたら、完了の操作と同じく task-complete を積む（画面の並びは替えない）。
  // 完了の列から落としたら、task-reopen で戻してから、落とした列と位置へ task-column-move を続ける（同じ待ち行列で順に送る）。
  // 画面を読み直したら、つかんでいるドラッグは取りやめ、離しても送らず、トーストで知らせる。落としたカードは光らせ、フォーカスは動かさない。
  // 列の開閉はワークスペースごとに端末へ保存する。畳んだ列も移動先に残し、空の行の書きかけは隠して保つ。
  // 進行中のスプリントが無いときは、見本の空の状態をロールで文を分けて出す。
  // 各列（完了の列を除く）の末尾に、タスクを足す空の行（DraftRow）を置く。書き込めるとき（終了していないワークスペース）だけ出す。
  // 題を打って Enter で、そのスプリントのその列の末尾に task-create で作る（作成と入れ込みは1回の書き込み）。作れたら読み直し、
  // 空の行に戻って続けて打てる。断られたら理由を空の行の下に出し、スプリントか列が無いか進行中でなければ読み直す。
  // 空の行の下には担当と期日のチップ（DraftAttrs）を置き、選んだ値も同じ1回の task-create で送る（#1501。#827 の「題だけで作る」を改めた）。
  // 選んだ値は列ごとに持ち、作れたら題と一緒に空に戻す（続けて作るタスクに前の値が付かないように）。Esc で書きかけを捨てたときも空に戻す。
  // 小窓の「編集」「延長する」「終える」は、リーダーか管理者、開いたワークスペースだけ。小窓を閉じてからダイアログを開き、閉じたらスプリントのボタンへ戻る。
  // 最終日がワークスペースの今日より前なら、ボタンに警告の印を付け、小窓の先頭に終えるのを促す警告（SprintOverdueNotice）を出す。
  // 終えたら読み直して進行中の無い表示に戻り、見出しへフォーカスを移す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const board = $derived(data.board);
  const workspaceId = $derived(workspace?.id ?? '');
  const collapsedColumns = $derived.by(() => {
    const id = workspaceId;
    return untrack(() => new SprintColumnCollapse(id));
  });
  $effect(() => collapsedColumns.listen(window));
  // カードの「⋯」から消した（戻した）後の読み直しの失敗の印（#979。task-reload-failure.svelte.ts）。ボードが読めたら下ろす
  $effect(() => {
    if (board !== null) untrack(clearReloadFailure);
  });
  const slug = $derived(page.params.slug ?? '');
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  const isLeader = $derived(workspace !== null && (workspace.role === 'leader' || isAdmin));
  const isClosed = $derived(workspace !== null && workspace.closedAt !== null);
  const canWrite = $derived(workspace !== null && !isClosed);
  // `c` で、開いている完了でない最初の列の空の行へフォーカスを移す。行が無い（書き込めない、列が無い）間は働かない
  // bind:this は、部品が外れると null に戻る
  let draftRows = $state<Record<string, DraftRow | null | undefined>>({});
  const draftInputs = $derived.by(() => {
    const id = workspaceId;
    return { id, rows: new Map<string, DraftRowState>() };
  });
  function draftInputOf(columnId: string): DraftRowState {
    const { rows } = draftInputs;
    let state = rows.get(columnId);
    if (state === undefined) {
      state = new DraftRowState();
      rows.set(columnId, state);
    }
    return state;
  }
  // 列ごとの、空の行で作る前に選んだ担当と期日（#1501）
  type DraftChoice = { assignee: { id: string; name: string } | null; due: string | null };
  let draftChoices = $state<Record<string, DraftChoice>>({});
  const NO_DRAFT_CHOICE: DraftChoice = { assignee: null, due: null };
  function draftChoiceOf(columnId: string): DraftChoice {
    return draftChoices[columnId] ?? NO_DRAFT_CHOICE;
  }
  function setDraftChoice(columnId: string, patch: Partial<DraftChoice>): void {
    draftChoices[columnId] = { ...draftChoiceOf(columnId), ...patch };
  }
  function clearDraftChoice(columnId: string): void {
    delete draftChoices[columnId];
  }
  // 別のワークスペースへ移ったら選択を捨てる（ページは作り直されないので、戻ったときに前の選択が空の題の行に残り、黙って付くのを防ぐ）
  let draftWorkspaceId = '';
  $effect(() => {
    const id = workspaceId;
    untrack(() => {
      if (id === draftWorkspaceId) return;
      draftWorkspaceId = id;
      draftChoices = {};
    });
  });
  const firstDraftRow = (): DraftRow | null | undefined =>
    firstOpenColumnId === undefined ? undefined : draftRows[firstOpenColumnId];
  useShortcut(() => ({
    id: 'sprint-new-task',
    keys: NEW_TASK_KEY,
    label: () => t('shortcutNewTask', { task: t('task') }),
    enabled: () => firstDraftRow() != null,
    run: () => firstDraftRow()?.focus(),
  }));
  const canLead = $derived(isLeader && !isClosed);
  const sprint = $derived(board?.sprint ?? null);
  // カードと空の行自身が受けるキー。中央の振り分けへ操作を増やさず、一覧だけに出す。
  useShortcut(() => ({
    id: 'sprint-card-columns',
    keys: 'Alt + ← →',
    label: () => t('shortcutSprintCardColumns', { column: t('column'), done: t('done') }),
    helpOnly: true,
    enabled: () => canWrite && sprint !== null,
  }));
  useShortcut(() => ({
    id: 'sprint-card-order',
    keys: 'Alt + ↑ ↓',
    label: () => t('shortcutSprintCardOrder', { column: t('column') }),
    helpOnly: true,
    enabled: () => canWrite && sprint !== null,
  }));
  useShortcut(() => ({
    id: 'sprint-column-add',
    keys: 'Enter',
    label: () => t('shortcutSprintColumnAdd', { task: t('task'), column: t('column') }),
    helpOnly: true,
    enabled: () => canWrite && sprint !== null,
  }));
  // 日付は YYYY-MM-DD なので、文字列の比較が日付の前後と一致する。終了したワークスペースでは、誰も終えられないので促さない
  const overdue = $derived(!isClosed && sprint !== null && board !== null && board.today > sprint.end_on);
  let editDialog = $state<ReturnType<typeof SprintDialog>>();
  let extendDialog = $state<ReturnType<typeof SprintExtendDialog>>();
  let closeDialog = $state<ReturnType<typeof SprintCloseDialog>>();
  const boardHref = $derived(
    resolve('/[slug]/w/[id]/board', { slug: page.params.slug ?? '', id: page.params.id ?? '' }),
  );
  const planHref = $derived(resolve('/[slug]/w/[id]/plan', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));
  const backlogHref = $derived(resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));

  // 画面で動かした後の列とカード。読み直したら捨てる
  let local = $state<SprintBoardColumn[] | null>(null);
  const columns = $derived(local ?? board?.columns ?? []);
  // 絞り込み（#1502）。URL の問い合わせ（?q=&assignee=&story=&epic=&category=）から読み、読み込んだボードを画面で絞る。
  // 前からある ?story=<ID> のリンク（通知など）も同じ形で読む
  // 送っている途中の絞り込み。続けて押したとき、URL が替わる前でも直前の操作を土台にする（前の操作を落とさない）
  let pendingFilter = $state<BoardFilter | null>(null);
  const filter = $derived(pendingFilter ?? boardFilterOf(page.url.searchParams));
  const choices = $derived(boardChoicesOf(columns));
  // ストーリーを1つだけ選んでいる間は、追加の行で作るタスクをそのストーリーの下に入れる（前の ?story= の絞り込みと同じ）
  const storyId = $derived.by(() => {
    const id = storyForCreate(filter);
    return id !== null && choices.story.some((choice) => choice.id === id) ? id : null;
  });
  // カードの題のリンク（?task=）にも絞り込みを添え、引き出しを開閉しても絞り込みを保つ
  const cardFilterQuery = $derived(boardFilterQuery(filter));
  // ボード全体で選んだ値が無くなれば（消えたストーリー、別のボードのリンク）、URLを直接開いた場合も操作後も同じ条件で外す。
  const hasBoard = $derived(board !== null);
  let clearingFilterHref: string | null = null;
  $effect(() => {
    const href = page.url.href;
    const pruned = hasBoard ? prunedBoardFilter(filter, choices) : null;
    if (pruned === null || pruned.removed.length === 0) {
      clearingFilterHref = null;
      return;
    }
    if (clearingFilterHref === href) return;
    clearingFilterHref = href;
    const onlyStory = pruned.removed.length === 1 && pruned.removed[0] === 'story';
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 現在の経路の絞り込みの問い合わせだけを除く
    void goto(boardFilterHref(page.url, pruned.filter), { replace: true, reset: false })
      .then(() =>
        announce(
          onlyStory
            ? t('sprintStoryFilterInvalid', { story: t('story') })
            : t('boardFilterInvalid', { board: t('board') }),
        ),
      )
      .catch(() => showToast(t('sprintStoryFilterClearFailed'), 'alert'));
  });
  const visibleColumns = $derived(filterColumns(columns, filter));
  const lanes = $derived(filter.group === undefined ? [] : boardLanesOf(visibleColumns, filter.group));
  let collapsedLanes = $state<Record<string, boolean>>({});
  const laneKey = (id: string): string => `${workspaceId}:${filter.group}:${id}`;
  const laneIsCollapsed = (id: string): boolean => collapsedLanes[laneKey(id)] ?? false;
  function toggleLane(id: string): void {
    collapsedLanes[laneKey(id)] = !laneIsCollapsed(id);
    dnd.reset();
  }
  function laneName(id: string, label: string): string {
    if (id !== BOARD_FILTER_NONE) return label;
    if (filter.group === 'assignee') return t('unassigned');
    if (filter.group === 'epic') return t('filterNoEpic', { epic: t('epic') });
    return t('boardGroupNoParent');
  }
  const visibleCount = $derived(visibleColumns.reduce((total, column) => total + column.tasks.length, 0));
  const totalCount = $derived(columns.reduce((total, column) => total + column.tasks.length, 0));
  const hiddenIn = (columnId: string): number =>
    (columns.find((column) => column.id === columnId)?.tasks.length ?? 0) -
    (visibleColumns.find((column) => column.id === columnId)?.tasks.length ?? 0);
  // ポインタの強調（undefined はカードの上にいない）が、親名のボタンのフォーカスより先。親のないカードに乗れば、フォーカスがあっても消す。
  // ただし親名へフォーカスが移ったときは、ポインタの強調を捨ててフォーカスを先にする（onstoryfocus）
  let hoveredStory = $state<string | null | undefined>(undefined);
  let focusedStory = $state<string | null>(null);
  // 隙間で保った強調のストーリーが盤から消えたら（削除、読み直し、列を畳んで描かなくなった）、保った強調を捨ててフォーカスの強調に戻す
  const visibleStoryIds = $derived(
    new Set(
      visibleColumns
        .filter((column) => !collapsedColumns.isCollapsed(column.id))
        .flatMap((column) =>
          column.tasks
            .filter((task) => filter.group === undefined || !laneIsCollapsed(boardFilterValue(task, filter.group)))
            .map((task) => task.story?.id ?? null),
        ),
    ),
  );
  const highlightedStory = $derived(
    hoveredStory === null || (hoveredStory !== undefined && visibleStoryIds.has(hoveredStory))
      ? hoveredStory
      : focusedStory,
  );
  // 盤から消えたストーリーの保った強調は無視するだけでなく捨て、同じストーリーが盤に戻っても古い強調を出さない
  $effect(() => {
    if (typeof hoveredStory === 'string' && !visibleStoryIds.has(hoveredStory)) hoveredStory = undefined;
  });
  // カードの隙間（列の地と盤の地）では直前のカードの強調を保ち、ちらつかせない。見出しや足す行など、ほかの部分に移るか盤を出たら外す
  function trackStoryHover(node: HTMLElement): () => void {
    const over = (event: PointerEvent): void => {
      const target = event.target;
      // 強調を付けるのはカードの側で、タッチでは付けない。外す側はタッチでも通し、持ち替えの前の強調を残さない（カードに触れたときも外す）
      if (!(target instanceof Element)) return;
      if (target === node || target.classList.contains('board-col')) return;
      if (target.closest('.card') && event.pointerType !== 'touch') return;
      hoveredStory = undefined;
    };
    const leave = (): void => {
      hoveredStory = undefined;
    };
    node.addEventListener('pointerover', over);
    node.addEventListener('pointerleave', leave);
    return () => {
      node.removeEventListener('pointerover', over);
      node.removeEventListener('pointerleave', leave);
    };
  }
  // 絞り込みを URL に書く。履歴は積まない（読み直しても同じ絞り込みで開く）
  let filterSends = 0;
  async function applyFilter(next: BoardFilter, message?: string): Promise<void> {
    if (sameBoardFilter(next, filter)) return;
    const onlyGroupChanged = sameBoardFilter({ ...next, group: filter.group }, filter);
    hoveredStory = undefined;
    const sent = ++filterSends;
    pendingFilter = next;
    try {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 現在の経路の絞り込みの問い合わせだけを替える
      await goto(boardFilterHref(page.url, next), { replace: true, reset: false });
    } finally {
      if (sent === filterSends) pendingFilter = null;
    }
    if (message !== undefined) {
      await announce(message);
      return;
    }
    if (onlyGroupChanged) return;
    const shown = filterColumns(columns, next).reduce((total, column) => total + column.tasks.length, 0);
    await announce(
      !isBoardFiltering(next)
        ? t('boardFilterCleared')
        : shown === 0
          ? t('filterResultNone')
          : t('filterResultCount', { count: shown }),
    );
  }

  // カードの親のストーリーを押したら、そのストーリーで絞る（ほかの条件は残す）
  async function filterStory(id: string): Promise<void> {
    const title = columns.flatMap((column) => column.tasks).find((task) => task.story?.id === id)?.story?.title;
    focusedStory = null;
    await applyFilter(
      { ...filter, story: [id] },
      t('sprintStoryFilterApplied', { story: t('story'), title: title ?? '' }),
    );
  }

  // 「すべてクリア」。ストーリーを1つだけで絞っていたときは、そのストーリーの親名へフォーカスを戻す（前の絞り込みの帯と同じ）。
  // ほかは、ボタンが消えるので検索の欄へ移す
  let filterBar = $state<ReturnType<typeof BoardFilterBar>>();
  async function clearFilter(): Promise<void> {
    const previous = filter;
    const onlyStory =
      previous.q === '' &&
      previous.story.length === 1 &&
      previous.assignee.length + previous.epic.length + previous.category.length === 0;
    const previousStory = onlyStory ? previous.story[0]! : null;
    hoveredStory = undefined;
    focusedStory = null;
    // 送っている途中の絞り込みは捨てる（後から届いても全件のままにする）
    filterSends += 1;
    pendingFilter = null;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 現在の経路の絞り込みの問い合わせだけを除く
    await goto(boardFilterHref(page.url, { ...emptyBoardFilter, group: previous.group }), {
      replace: true,
      reset: false,
    });
    await announce(onlyStory ? t('sprintStoryFilterCleared', { story: t('story') }) : t('boardFilterCleared'));
    await tick();
    if (previousStory !== null) {
      const parent = document.querySelector<HTMLElement>(`[data-story-filter="${CSS.escape(previousStory)}"]`);
      if (parent) {
        parent.focus();
        return;
      }
      const task = columns.flatMap((column) => column.tasks).find((item) => item.story?.id === previousStory);
      if (task && collapsedColumns.isCollapsed(columns.find((c) => c.tasks.includes(task))?.id ?? '')) {
        focusCollapsedColumn(task.id);
        return;
      }
    }
    filterBar?.focusSearch();
  }
  // `c` が移る列と、aria-keyshortcuts を付ける列は、同じ（開いている完了でない最初の列）
  const firstOpenColumnId = $derived(
    columns.find((item) => !item.is_done && !collapsedColumns.isCollapsed(item.id))?.id,
  );
  // 動かし方の見えない説明。書き込めるカードの aria-describedby に結ぶ
  const KEY_HINT_ID = 'sprint-board-key-hint';
  const moves = new MoveQueue<ApiResult<unknown>>({
    reload: reloadBoard,
    dropped: () => showToast(t('moveReloaded'), 'alert'),
  });
  // ドラッグで落とした完了か戻し（と、続く列の移動）を、積んでから終えるまでのカード。この間は、そのカードをつかめない
  // （完了を送っている最中に完了の列から落とすと、誤った「完了していない」の断りが出るため）
  let sendingIds = $state<string[]>([]);
  const dnd = new SprintDnd({
    columns: () => visibleColumns,
    group: () => filter.group,
    enabled: () => canWrite,
    busy: (id) => sendingIds.includes(id) || completingId === id || reopeningId === id,
    onDrop: dropCard,
    onStale: () => showToast(t('moveReloaded'), 'alert'),
  });
  $effect(() => dnd.monitor());
  // 読み直したら、つかんでいるドラッグは取りやめる（離しても何も送らない）。光らせているカードは、読み直した後も残す
  dnd.resetWhenChanged(() => board);
  dnd.resetWhenChanged(() => cardFilterQuery);
  // 完了にした、または戻したカード。読み直した後の列に出てから光らせる（応答の直後に光らせると、読み直しが遅いとき元の列で終わる）
  let flashAfterReload: string | null = null;
  $effect.pre(() => {
    void board;
    local = null;
    moves.reloaded();
    if (flashAfterReload !== null) {
      dnd.flash(flashAfterReload);
      flashAfterReload = null;
    }
  });

  // 積んだ操作（完了か戻し）を終えるまで、そのカードをつかめなくする
  function whileSending(id: string, sent: Promise<void>): void {
    sendingIds = [...sendingIds, id];
    void sent.then(() => {
      const at = sendingIds.indexOf(id);
      if (at !== -1) sendingIds = sendingIds.toSpliced(at, 1);
    });
  }

  // 動かした結果の読み上げ。領域は常に置き、中の文字だけを替える。同じ文が続いても読まれるよう、一度空にしてから入れる
  let status = $state('');
  async function announce(message: string): Promise<void> {
    status = '';
    await tick();
    status = message;
  }

  // 完了か戻しを送っている間に、もう1つの完了か戻しが来たら送らずに捨て、送っている最中であることを読み上げる。捨てたら真
  function refusedWhileBusy(): boolean {
    if (completingId === null && reopeningId === null) return false;
    void announce(
      completingId !== null
        ? t('sprintCardBusyCompleting', { done: t('done') })
        : t('sprintCardBusyReopening', { done: t('done') }),
    );
    return true;
  }

  let completingId = $state<string | null>(null);
  let reopeningId = $state<string | null>(null);
  // 完了の列の完成の定義を開いているか。本文は開くまで描かない（バックログの画面と同じ）
  let dodOpen = $state(false);

  function columnName(column: SprintBoardColumn): string {
    return column.is_done ? t('done') : (column.name ?? '');
  }

  // カードの上で直す（ポイントと担当のチップ、題の鉛筆）ときの配線。書き込めるときだけ渡す（#1499）。
  // 保存が通ったら、そのカードだけを画面の並びで直し（列の合計も変わる）、断られたら読み直す
  const cardAttrs = $derived(
    canWrite && workspace !== null
      ? {
          slug,
          workspaceId,
          meId: data.organization?.me.id ?? null,
          loadedAt: data.loadedAt,
          onpatch: patchCard,
          onSaved: reloadBoard,
          onStale: () => void invalidateAll(),
        }
      : undefined,
  );
  function patchCard(id: string, patch: Partial<SprintBoardTask>): void {
    local = columns.map((column) =>
      column.tasks.some((task) => task.id === id)
        ? { ...column, tasks: column.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) }
        : column,
    );
  }

  function pointsOf(tasks: readonly SprintBoardTask[]): number {
    return tasks.reduce((total, task) => total + (task.points ?? 0), 0);
  }

  const allTasks = $derived(columns.flatMap((column) => column.tasks));
  const progress = $derived(sprint !== null && board !== null ? sprintProgress(sprint, board.today) : null);
  const doneColumnTasks = $derived(columns.filter((column) => column.is_done).flatMap((column) => column.tasks));

  async function reloadBoard(): Promise<void> {
    const saved = savedFocus();
    try {
      await invalidate('app:sprint-board');
    } finally {
      local = null;
    }
    await restoreFocus(saved);
  }

  // フォーカスのあるカード（data-card-id）と、その中で何番目の操作か（-1 はカードそのもの）。並べ替えや読み直しでカードの要素が
  // 作り直されても、同じカードの同じ操作へフォーカスを戻す
  function savedFocus(): { id: string; index: number } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const card = active.closest<HTMLElement>('[data-card-id]');
    if (card === null) return null;
    const index = active === card ? -1 : [...card.querySelectorAll<HTMLElement>('a, button')].indexOf(active);
    return { id: card.dataset.cardId ?? '', index };
  }

  async function restoreFocus(saved: { id: string; index: number } | null): Promise<void> {
    if (saved === null) return;
    await tick();
    // 読み直しを待つ間に題の欄や担当の絞り込みの欄で書き始めていたら、そこからフォーカスを奪わない
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.closest('[data-card-id]')) return;
    const card = [...document.querySelectorAll<HTMLElement>('[data-card-id]')].find(
      (el) => el.dataset.cardId === saved.id,
    );
    if (card === undefined) {
      // キーで畳んだ列へ送ったときは、消えたカードの代わりに列の開閉へ移る。
      focusCollapsedColumn(saved.id);
      return;
    }
    const control = saved.index === -1 ? card : card.querySelectorAll<HTMLElement>('a, button')[saved.index];
    (control ?? card).focus();
  }

  function focusCollapsedColumn(taskId: string, columnId?: string): void {
    const column =
      columnId === undefined
        ? columns.find((candidate) => candidate.tasks.some((task) => task.id === taskId))
        : columns.find((candidate) => candidate.id === columnId);
    if (column && collapsedColumns.isCollapsed(column.id)) {
      [...document.querySelectorAll<HTMLButtonElement>('[data-column-toggle]')]
        .find((button) => button.dataset.columnToggle === column.id)
        ?.focus();
    }
  }

  function focusTaskOrCollapsedColumn(taskId: string, selector: string, columnId?: string): void {
    const control = document.querySelector<HTMLElement>(selector);
    if (control) control.focus();
    else focusCollapsedColumn(taskId, columnId);
  }

  function edgeMessage(edge: MoveEdge): string {
    if (edge === 'top') return t('moveAtTop');
    if (edge === 'bottom') return t('moveAtBottom');
    if (edge === 'prev') return t('sprintCardNoPrevColumn', { column: t('column') });
    return t('sprintCardNoNextColumn', { column: t('column') });
  }

  // 断られた移動の理由。409 の conflict は、サーバーが details.reason に載せた理由で分ける
  function moveFailureMessage(result: { status: number; error: { code: string; details?: unknown } | null }): string {
    if (result.status === 404) return t('sprintCardMoveGone', { task: t('task'), column: t('column') });
    if (result.status === 409 && result.error?.code === 'workspace_closed') {
      return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    }
    if (result.status === 409) {
      switch (columnMoveConflictReasonOf(result.error?.details)) {
        case 'done_column':
          return t('sprintCardMoveDoneColumn', { done: t('done'), column: t('column') });
        case 'task_completed':
          return t('moveTaskDone', { task: t('task'), done: t('done') });
        case 'not_active':
          return t('sprintCardMoveNotActive', { sprint: t('sprint') });
        case 'changed':
          return t('moveConflict');
        default:
          return t('sprintCardMoveFailed');
      }
    }
    return t('sprintCardMoveFailed');
  }

  const reopenKey = new ReopenKeyGuard();
  const keyWorkspaceId = $derived(workspace?.id);
  $effect(() => {
    void keyWorkspaceId;
    reopenKey.reset();
  });

  function moveCard(task: SprintBoardTask, direction: MoveDirection, repeat?: boolean): void {
    if (workspace === null || !canWrite) return;
    if (direction === 'left' && reopenKey.suppress(repeat)) return;
    if (task.completed_at !== null) {
      if (direction === 'left') {
        reopenKey.start(repeat);
        // ドラッグの戻しが送信待ちの間も、同じカードをキーやメニューから重ねて送らない。
        if (sendingIds.includes(task.id)) {
          void announce(t('sprintCardBusyReopening', { done: t('done') }));
          return;
        }
        void reopen(task);
      }
      return;
    }
    if (sendingIds.includes(task.id)) return;
    const group = filter.group;
    const lane = group === undefined ? undefined : lanes.find((item) => item.id === boardFilterValue(task, group));
    const plan = planCardMove(lane?.columns ?? visibleColumns, task.id, direction);
    if (plan === null) return;
    // 次の列が完了の列なら、完了にする
    if (plan.kind === 'complete') {
      queueComplete(task);
      return;
    }
    // 端で押したときは、動かせないことを読み上げる
    if (plan.kind === 'edge') {
      void announce(edgeMessage(plan.edge));
      return;
    }
    applyMove(task, plan);
  }

  // 完了にする。先に押した移動を送り終えてから送るよう、同じ列に並べる。
  // 読み直しは、ここでは行わず、列が空になった後に回す（reloadOnSuccess）。読み直しが列の途中で MoveQueue の世代を進めると、
  // 続けて積んだ操作（続けて落としたカードの移動など）が送られずに捨てられるため。
  // ドラッグで落としたとき（dropped）は、完了になったカードを光らせ、フォーカスは動かさない。キーでは、読み直した後に題のリンクへ移す
  function queueComplete(task: SprintBoardTask, dropped = false): void {
    let completed = false;
    const sent = moves.send(
      async () => {
        completed = await complete(task);
        if (completed && dropped) flashAfterReload = task.id;
        return completed ? ({ ok: true, data: null } as const) : ({ ok: false, status: 0, error: null } as const);
      },
      async () => {},
      true,
    );
    whileSending(task.id, sent);
    if (dropped) return;
    void sent.then(async () => {
      if (!completed) return;
      await tick();
      focusTaskOrCollapsedColumn(task.id, `a[data-task-id="${CSS.escape(task.id)}"]`);
    });
  }

  // 動かした先の位置の読み上げ
  function movedMessage(task: SprintBoardTask, plan: Pick<MovedPlan, 'column' | 'index' | 'total'>): string {
    return t('sprintCardMoved', {
      title: task.title,
      column: columnName(plan.column),
      index: plan.index + 1,
      total: plan.total,
    });
  }

  // task-column-move の入力。直前のカードは、null が先頭、undefined が末尾（省く）
  function columnMoveInput(
    workspaceId: string,
    task: SprintBoardTask,
    columnId: string,
    afterTaskId: string | null | undefined,
  ) {
    return {
      workspace_id: workspaceId,
      task_id: task.id,
      column_id: columnId,
      ...(afterTaskId === undefined ? {} : { after_task_id: afterTaskId }),
    };
  }

  // 断られた task-column-move。理由を知らせて読み直す
  async function moveRefused(workspaceId: string, result: ApiResult<unknown>): Promise<void> {
    // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
    if (workspaceId !== page.params.id || result.ok) return;
    // 401 は、枠の読み直しがログインの画面へ移す
    if (result.status === 401) {
      await invalidateAll();
      return;
    }
    dnd.clearFlash();
    showToast(moveFailureMessage(result), 'alert');
    if (result.status === 409 && result.error?.code === 'workspace_closed') await invalidate('app:workspace');
    await reloadBoard();
  }

  // 先に画面の並びを替えて、位置を読み上げ、task-column-move を積む（ボタンとキーとドラッグで同じ）。ドラッグで落としたときは光らせる
  function applyMove(task: SprintBoardTask, plan: MovedPlan, flash = false): void {
    if (workspace === null) return;
    const saved = savedFocus();
    local = applyFilteredMove(columns, task.id, plan.column.id, plan.afterTaskId);
    void restoreFocus(saved);
    if (flash) dnd.flash(task.id);
    const hiddenDrop = flash && collapsedColumns.isCollapsed(plan.column.id);
    if (!hiddenDrop) void announce(movedMessage(task, plan));
    const workspaceId = workspace.id;
    const input = columnMoveInput(workspaceId, task, plan.column.id, plan.afterTaskId);
    void moves.send(
      async () => {
        const result = await callOperation(taskColumnMove, input, { slug });
        if (result.ok && hiddenDrop && workspaceId === page.params.id) showToast(movedMessage(task, plan), 'check');
        return result;
      },
      (result) => moveRefused(workspaceId, result),
    );
  }

  // 完了の列のカードを、完了でない列へ落とした。task-reopen で戻してから、落とした列と位置へ task-column-move を続ける。
  // 戻すのが断られたら（理由は reopen が知らせて読み直す）、列の移動は送らない。通ったら、列が空になった後で読み直す
  function applyReopenMove(task: SprintBoardTask, plan: ReopenPlan): void {
    if (workspace === null) return;
    const workspaceId = workspace.id;
    const sent = moves.send(
      async () => {
        if (!(await reopen(task, true))) return { ok: true, data: null } as const;
        const result = await callOperation(
          taskColumnMove,
          columnMoveInput(workspaceId, task, plan.column.id, plan.afterTaskId),
          {
            slug,
          },
        );
        if (result.ok && workspaceId === page.params.id) {
          if (collapsedColumns.isCollapsed(plan.column.id)) showToast(movedMessage(task, plan), 'check');
          else void announce(movedMessage(task, plan));
          flashAfterReload = task.id;
        }
        return result;
      },
      (result) => moveRefused(workspaceId, result),
      true,
    );
    // 戻しと移動が終わるまで、そのカードをつかめない
    whileSending(task.id, sent);
  }

  function assignDroppedCard(task: SprintBoardTask, plan: Extract<SprintDrop['plan'], { kind: 'assign' }>): void {
    if (workspace === null) return;
    const workspaceId = workspace.id;
    const options = { slug };
    const assignee = taskAttributes(slug, workspaceId, task.id).assignee;
    const release = assignee.reserve();
    if (release === null) {
      showToast(t('boardGroupAssignSending', { assignee: t('assignee') }), 'alert');
      return;
    }
    let failedAssign = false;
    const sent = moves.send(
      async () => {
        const assigned = await callOperation(
          taskAssign,
          { workspace_id: workspaceId, task_id: task.id, assignee_user_id: plan.assigneeId },
          options,
        );
        if (!assigned.ok) {
          failedAssign = true;
          return assigned;
        }
        assignee.observe(assigned.data.task.assignee?.id ?? '', performance.now());
        if (workspaceId !== page.params.id || options.slug !== slug) return assigned;
        const next = plan.next;
        if (next?.kind === 'complete') {
          if (await complete(task)) flashAfterReload = task.id;
          return assigned;
        }
        if (next?.kind === 'moved') {
          const result = await callOperation(
            taskColumnMove,
            columnMoveInput(workspaceId, task, next.column.id, next.afterTaskId),
            options,
          );
          if (!result.ok) return result;
        }
        if (workspaceId === page.params.id && options.slug === slug) {
          flashAfterReload = task.id;
          showToast(
            t('boardGroupChanged', {
              title: task.title,
              assignee: t('assignee'),
              name: assigned.data.task.assignee?.name ?? t('unassigned'),
            }),
            'check',
          );
          if (next !== null) void announce(movedMessage(task, next));
        }
        return assigned;
      },
      async (result) => {
        if (workspaceId !== page.params.id || options.slug !== slug || result.ok) return;
        if (!failedAssign) {
          await moveRefused(workspaceId, result);
        } else if (result.status === 401) {
          await invalidateAll();
        } else {
          showToast(t('boardGroupAssignFailed', { task: t('task'), assignee: t('assignee') }), 'alert');
          if (result.error?.code === 'workspace_closed') await invalidate('app:workspace');
          await reloadBoard();
        }
      },
      true,
    );
    whileSending(task.id, sent.finally(release));
  }

  // カードを落とした（つかんでいる間に画面が読み直されていれば、ここへは来ない）
  function dropCard(drop: SprintDrop): void {
    if (workspace === null || !canWrite) return;
    const task = allTasks.find((candidate) => candidate.id === drop.taskId);
    if (task === undefined) return;
    if (drop.plan.kind === 'complete') queueComplete(task, true);
    else if (drop.plan.kind === 'reopen') applyReopenMove(task, drop.plan);
    else if (drop.plan.kind === 'reopen-blocked') void refuseReopen();
    else if (drop.plan.kind === 'assign') assignDroppedCard(task, drop.plan);
    else if (drop.plan.kind === 'moved') applyMove(task, drop.plan, true);
  }

  // 完了にできたら true（別の画面で先に完了にされていたときも）。queueComplete から呼び、成功時の読み直しとフォーカスは待ち行列側が扱う。
  async function complete(task: SprintBoardTask): Promise<boolean> {
    if (workspace === null || refusedWhileBusy()) return false;
    completingId = task.id;
    const workspaceId = workspace.id;
    let done = false;
    try {
      const result = await callOperation(taskComplete, { workspace_id: workspaceId, task_id: task.id }, { slug });
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (workspaceId !== page.params.id) return false;
      if (result.ok || (result.status === 409 && result.error?.code === 'conflict')) {
        done = true;
        // 別の画面で先に完了にされていたときも、読み直して完了の列に置く
        const message = result.ok
          ? completedMessage(result.data.left_sprint, t)
          : t('taskAlreadyDone', { task: t('task'), done: t('done') });
        // トーストが読み上げる
        showToast(message, 'check');
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        showToast(t('taskGone', { task: t('task') }), 'alert');
        await invalidate('app:sprint-board');
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        await invalidate('app:workspace');
      } else {
        showToast(t('taskCompleteFailed', { done: t('done') }), 'alert');
      }
    } finally {
      completingId = null;
    }
    return done;
  }

  // 断られた戻しの理由。409 の conflict は、サーバーが details.reason に載せた理由で分ける
  function reopenFailureMessage(details: unknown): string {
    const words = { task: t('task'), done: t('done'), sprint: t('sprint'), story: t('story') };
    switch (taskReopenConflictReasonOf(details)) {
      case 'not_completed':
        return t('taskReopenNotDone', words);
      case 'sprint_closed':
        return t('taskReopenSprintClosed', words);
      case 'parent_completed':
        return t('taskReopenParentDone', words);
      default:
        return t('taskReopenChanged');
    }
  }

  // 「⋯」の「この<タスク>を削除する」。確認は挟まず、消したら「取り消す」付きのトーストを出してボードを読み直す。
  // 消したカードの前後（無ければ見出し）へのフォーカスの移し方は、引き出しの削除と同じ（task-removal.ts）。
  // カードが消えるので、読み直しでフォーカスを戻す先（savedFocus）は使わない
  async function removeCard(task: SprintBoardTask, keyboard: boolean): Promise<void> {
    if (workspace === null || !canWrite) return;
    const workspaceId = workspace.id;
    const reload = async (): Promise<void> => {
      // 送っている動かしが終わってから読み直す（先に読み直すと、動かしたカードが一時的に元の列に見える）。MoveQueue の列が空になるまで待つ
      await moves.whenIdle();
      try {
        await invalidate('app:sprint-board');
      } finally {
        local = null;
      }
      await throwIfListFailed(() => page.data);
    };
    await removeFromList({
      slug,
      workspaceId,
      taskId: task.id,
      title: task.title,
      keyboard,
      fromSprint: true,
      reload,
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路から task などの問い合わせを外しただけ
      closeDrawer: (path) => goto(path, { replace: true, reset: false }),
      onstale: () => void invalidate('app:workspace'),
      // 取り消したタスクはスプリントには戻らずバックログにある。ボードに題のリンクが無いので見出しへ移す
      // （押したボタンにフォーカスがあったときだけ）。トーストは画面をまたいで残るので、バックログの画面に移った後でも効くよう、
      // 両方の画面が依存する `app:backlog-tree` を1回だけ読み直す（スプリントの load も同じ印に依存する）
      onrestored: async (restoredId, focus) => {
        try {
          await invalidate('app:backlog-tree');
        } finally {
          local = null;
        }
        await throwIfListFailed(() => page.data);
        await focusRestored(restoredId, focus);
      },
      onskipped: focusSkipped,
      onreloadfailed: (failure) => markReloadFailed(failure, workspaceId),
    });
  }

  // 進行中ボードの完了カードで reopenable が偽なのは、完了した親ストーリーの下。APIと同じ文で試行を断る。
  async function refuseReopen(): Promise<void> {
    if (workspace === null) return;
    const workspaceId = workspace.id;
    showToast(reopenFailureMessage({ reason: 'parent_completed' }), 'alert');
    // 既に積んだ移動を捨てない。読み直す前に、その移動と最後の再読込まで待つ。
    await moves.whenIdle();
    if (workspaceId !== page.params.id) return;
    try {
      await reloadBoard();
      await throwIfListFailed(() => page.data);
    } catch {
      if (workspaceId === page.params.id) markReloadFailed('stale', workspaceId);
    }
  }

  // 戻す。戻せたら true。followed が真のとき（ドラッグで別の列へ落とすとき）は、通ってもトーストを出さず、読み直さず、
  // フォーカスも動かさない（続けて task-column-move を送り、列が空になった後で画面が読み直し、位置を読み上げる）。断られたときの扱いは同じ
  async function reopen(task: SprintBoardTask, followed = false): Promise<boolean> {
    if (workspace === null || refusedWhileBusy()) return false;
    if (!task.reopenable) {
      await refuseReopen();
      return false;
    }
    reopeningId = task.id;
    const workspaceId = workspace.id;
    let reopened = false;
    try {
      const result = await callOperation(taskReopen, { workspace_id: workspaceId, task_id: task.id }, { slug });
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (workspaceId !== page.params.id) return false;
      if (result.ok) {
        reopened = true;
        if (!followed) {
          const column = columns.find((candidate) => candidate.id === result.data.column_id);
          // トーストが読み上げる。ドラッグで落としたときは、戻した列を言っても落とした列と食い違うので出さず、
          // 移した後の位置の読み上げ（sprintCardMoved）だけにする
          showToast(
            column === undefined
              ? t('taskReopened', { task: t('task'), done: t('done') })
              : t('sprintCardReopened', { title: task.title, done: t('done'), column: columnName(column) }),
            'check',
          );
          await invalidate('app:sprint-board');
          // 戻した列に出た同じカードへフォーカスを移す
          await tick();
          focusTaskOrCollapsedColumn(
            task.id,
            `[data-card-id="${CSS.escape(task.id)}"]`,
            result.data.column_id ?? undefined,
          );
        }
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        showToast(t('taskGone', { task: t('task') }), 'alert');
        await invalidate('app:sprint-board');
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        await invalidate('app:workspace');
      } else if (result.status === 409) {
        showToast(reopenFailureMessage(result.error?.details), 'alert');
        await invalidate('app:sprint-board');
      } else {
        showToast(t('taskReopenFailed', { done: t('done') }), 'alert');
      }
    } finally {
      reopeningId = null;
    }
    return reopened;
  }

  // 空の行の題の検査（画面の検査は API の検証と同じ判定。空は送らないので required は出ない）
  function cardTitleProblem(title: string): string | null {
    const problem = taskTitleProblem(title);
    if (problem === null) return null;
    if (problem === 'too_long') return t('taskTitleTooLong', { max: TASK_TITLE_MAX_LENGTH });
    if (problem === 'invalid_character') return t('taskTitleInvalidCharacter');
    return t('taskTitleRequired');
  }

  // 列の末尾の空の行でタスクを作る。返すのは、空の行に出すエラーの文（成功は null）
  async function addCard(column: SprintBoardColumn, title: string): Promise<string | null> {
    if (workspace === null || sprint === null) return t('taskCreateFailed');
    const sentFor = page.params.id;
    const sentStoryId = storyId;
    const choice = { ...draftChoiceOf(column.id) };
    const result = await callOperation(
      taskCreate,
      {
        workspace_id: workspace.id,
        title,
        story_id: sentStoryId,
        assignee_user_id: choice.assignee?.id ?? null,
        due_on: choice.due,
        sprint: { sprint_id: sprint.id, column_id: column.id },
      },
      { slug },
    );
    // 送っている間に別のワークスペースへ移っていたら、成功も失敗も、古い応答で状態を触らない
    if (sentFor !== page.params.id) return null;
    if (!result.ok) {
      if (result.status === 401) {
        await invalidateAll();
        return t('taskCreateFailed');
      }
      if (result.status === 409 && result.error?.code === 'workspace_closed') {
        // 読み直すと行ごと消えるので、知らせはトーストにも出す
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        void invalidate('app:workspace');
        return t('workspaceClosedReadOnly', { workspace: t('workspace') });
      }
      if (result.status === 409 && taskCreateConflictReasonOf(result.error?.details) === 'done_column') {
        void reloadBoard();
        return t('sprintBoardAddDoneColumn', { done: t('done'), column: t('column'), task: t('task') });
      }
      if (result.status === 409 && taskCreateConflictReasonOf(result.error?.details) === 'closed') {
        void reloadBoard();
        return t('sprintBoardAddNotActive', { sprint: t('sprint'), task: t('task') });
      }
      if (sentStoryId !== null && result.status === 409 && result.error?.code === 'conflict') {
        void reloadBoard();
        return t('treeAddTaskParentDone', { story: t('story'), done: t('done'), task: t('task') });
      }
      if (result.status === 404) {
        void reloadBoard();
        if (choice.assignee !== null) {
          return sentStoryId === null
            ? t('sprintBoardAddAssigneeGone', {
                sprint: t('sprint'),
                column: t('column'),
                assignee: t('assignee'),
                task: t('task'),
              })
            : t('sprintBoardAddStoryAssigneeGone', {
                story: t('story'),
                sprint: t('sprint'),
                column: t('column'),
                assignee: t('assignee'),
                task: t('task'),
              });
        }
        return sentStoryId === null
          ? t('sprintBoardAddGone', { sprint: t('sprint'), column: t('column'), task: t('task') })
          : t('sprintBoardAddStoryGone', {
              story: t('story'),
              sprint: t('sprint'),
              column: t('column'),
              task: t('task'),
            });
      }
      return t('taskCreateFailed');
    }
    // 作れたら、選んだ担当と期日も空に戻す（題は DraftRow が空に戻す）
    clearDraftChoice(column.id);
    // 読み直してから、足したカードを列の末尾に出す（トーストが読み上げる）。絞り込みに当たらず見えないときは、そのことも知らせる。
    // 読み直しに失敗しても、作れたことはふだんの知らせで出す。読み直す間に別のワークスペースへ移っていたら、何も出さない
    let hidden = false;
    try {
      await reloadBoard();
      const created = columns.flatMap((item) => item.tasks).find((task) => task.id === result.data.task.id);
      hidden = created !== undefined && !cardMatches(created, filter);
    } catch {
      // 読み直せなかったときは、当たるかを確かめられないので、ふだんの知らせにする
    }
    if (sentFor !== page.params.id) return null;
    showToast(
      t(hidden ? 'boardTaskAddedHidden' : 'sprintBoardTaskAdded', {
        title: result.data.task.title,
        column: columnName(column),
      }),
      hidden ? 'alert' : 'check',
    );
    return null;
  }

  function openClose(trigger: HTMLElement): void {
    if (sprint !== null) closeDialog?.show(trigger, sprint);
  }

  // 終えたら、押した「終える」が消えるので、読み直して見出しへフォーカスを移す
  async function closed(): Promise<void> {
    await invalidate('app:sprint-board');
    await tick();
    focusPageHeading();
  }

  const emptyText = $derived(
    isClosed
      ? t('sprintBoardEmptyClosedText', { workspace: t('workspace'), sprint: t('sprint') })
      : isLeader
        ? t('sprintBoardEmptyLeaderText', {
            plan: t('plan'),
            sprint: t('sprint'),
            backlog: t('backlog'),
            task: t('task'),
            column: t('column'),
          })
        : t('sprintBoardEmptyMemberText', {
            sprint: t('sprint'),
            leader: t('leader'),
            task: t('task'),
            backlog: t('backlog'),
            done: t('done'),
          }),
  );
</script>

<svelte:window onkeyup={(event) => reopenKey.release(event.key)} onblur={() => reopenKey.reset()} />

<svelte:head>
  {#if workspace && board !== null}
    <title>
      {t('pageTitle', {
        page:
          sprint === null
            ? t('sprintBoardPageNameEmpty', { board: t('board'), workspace: workspace.name })
            : t('sprintBoardPageName', { board: t('board'), name: sprintLabel(sprint, t), workspace: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#if workspace && board === null}
  <LoadFailed inShell note={reloadFailureNote(workspace.id) ?? undefined} />
{:else if workspace && board !== null}
  <!-- 読み上げの領域。常に置き、文字だけを替える -->
  <div class="visually-hidden" role="status">
    {status}{completingId !== null ? t('sprintCardCompleting', { done: t('done') }) : ''}{reopeningId !== null
      ? t('sprintCardReopening', { done: t('done') })
      : ''}
  </div>

  {#if sprint === null || progress === null}
    <PageHead title={t('board')} narrowEyebrow={workspace.name} focusable />
    <EmptyState
      icon="columns"
      art="notice"
      title={t('sprintBoardEmptyTitle', { sprint: t('sprint') })}
      text={emptyText}
    >
      {#snippet actions()}
        {#if isLeader}
          <a class="btn is-sm" href={planHref}>{t('sprintBoardOpenPlan', { plan: t('plan') })}</a>
        {:else}
          <a class="btn is-sm" href={backlogHref}>{t('sprintBoardOpenBacklog', { backlog: t('backlog') })}</a>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <PageHead title={t('board')} focusable />
    <div class="board-page">
      <!-- 1段の道具の帯。左に検索、担当のアバター、フィルター（#1502）、右端のスプリントのボタンで、期間、進み具合、ゴールと、
           リーダーの操作を出す小窓を開く -->
      <BoardFilterBar
        bind:this={filterBar}
        {filter}
        {choices}
        shown={visibleCount}
        total={totalCount}
        onchange={(next) => void applyFilter(next)}
        onclear={() => void clearFilter()}
      >
        {#snippet end()}
          <!-- ワークスペースを移ったら（同じ画面の部品が使い回される）、開いた小窓を前のワークスペースのまま残さない -->
          {#key workspace.id}
            <Popover
              text={sprintLabel(sprint, t)}
              label={t(overdue ? 'sprintPopoverLabelOverdue' : 'sprintPopoverLabel', {
                sprint: t('sprint'),
                label: sprintLabel(sprint, t),
                note: t('sprintPopoverOverdueNote'),
              })}
              dialogLabel={t('sprintPopoverDialog', { sprint: t('sprint') })}
              icon={overdue ? 'alert' : 'clock'}
              tone={overdue ? 'warn' : undefined}
              note={overdue ? t('sprintPopoverOverdueNote') : undefined}
            >
              {#snippet children(close, trigger)}
                {#if overdue}
                  <SprintOverdueNotice
                    {sprint}
                    canClose={canLead}
                    onclose={() => {
                      close(false);
                      openClose(trigger);
                    }}
                  />
                {/if}
                <div class="popover-head">
                  <h2 class="popover-title">{sprintLabel(sprint, t)}</h2>
                  <div class="popover-meta">
                    <span
                      >{t('sprintPopoverPeriod', {
                        period: sprintPeriod(sprint, t),
                        length: progress.length,
                        day: progress.day,
                      })}</span
                    >
                    {#if sprint.extended_days > 0}<span>{t('sprintExtended', { days: sprint.extended_days })}</span
                      >{/if}
                  </div>
                </div>
                <div class="progress-summary">
                  <Progress
                    done={pointsOf(doneColumnTasks)}
                    all={pointsOf(allTasks)}
                    markerPercent={(progress.day / progress.length) * 100}
                    markerLabel={t('progressElapsed', {
                      day: progress.day,
                      length: progress.length,
                      percent: Math.round((progress.day / progress.length) * 100),
                    })}
                    detailed
                  />
                  <span class="progress-remaining">{t('sprintBoardRemaining', { days: progress.remaining })}</span>
                </div>
                {#if sprint.goal !== null}
                  <div class="popover-section">
                    <span class="popover-label">{t('sprintGoal')}</span>
                    <p class="popover-text">{sprint.goal}</p>
                  </div>
                {/if}
                {#if canLead}
                  <div class="popover-actions">
                    <button
                      class="btn is-sm"
                      type="button"
                      aria-label={t('sprintHeaderEditLabel', { sprint: t('sprint'), label: sprintLabel(sprint, t) })}
                      onclick={() => {
                        close(false);
                        editDialog?.show(trigger, sprint);
                      }}>{t('sprintHeaderEditAction')}</button
                    >
                    <button
                      class="btn is-sm"
                      type="button"
                      onclick={() => {
                        close(false);
                        extendDialog?.show(trigger, sprint);
                      }}>{t('sprintExtendAction')}</button
                    >
                    <button
                      class="btn is-sm"
                      type="button"
                      aria-label={t('sprintCloseLabel', { sprint: t('sprint'), label: sprintLabel(sprint, t) })}
                      onclick={() => {
                        close(false);
                        openClose(trigger);
                      }}>{t('sprintCloseAction')}</button
                    >
                  </div>
                {/if}
              {/snippet}
            </Popover>
          {/key}
        {/snippet}
      </BoardFilterBar>
      <div class="story-board">
        <!-- 列が並ぶと狭い幅で横に溢れる。カードが無いと中に止まる先が無く、キーボードで横へ送れないので、その間だけ領域に止まる -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="board-wrap"
          role="region"
          aria-label={t('sprintBoardRegion', {
            sprint: t('sprint'),
            label: sprintLabel(sprint, t),
            column: t('column'),
          })}
          tabindex={visibleColumns.every((column) => column.tasks.length === 0) ? 0 : undefined}
          {@attach canWrite ? (node) => dnd.wrap(node) : undefined}
        >
          <!-- 引き出しの前後のボタンの順は、ボードに今見えているカード（左の列から右へ、列の中は上から下） -->
          <div class="board" style:--board-cols={columns.length} {@attach trackTaskOrder} {@attach trackStoryHover}>
            {#snippet boardRow(rowColumns: SprintBoardColumn[], part: 'all' | 'head' | 'lane' | 'draft', lane?: string)}
              {#each rowColumns as column (column.id)}
                {#if part === 'draft' && (column.is_done || !canWrite)}
                  <div></div>
                {:else}
                  <svelte:element
                    this={part === 'draft' ? 'div' : 'section'}
                    class="board-col"
                    class:is-done={column.is_done}
                    class:is-collapsed={collapsedColumns.isCollapsed(column.id)}
                    role={part === 'lane' ? 'group' : undefined}
                    aria-label={part === 'draft' ? undefined : columnName(column)}
                    data-column={column.id}
                    data-drop={canWrite ? dnd.markOfColumn(column.id, lane) : undefined}
                    {@attach canWrite && (part === 'all' || part === 'lane') ? dnd.column(column.id, lane) : undefined}
                  >
                    {#if canWrite && dnd.markOfColumn(column.id, lane) === 'blocked'}
                      <span class="board-drop-blocked"><Icon name="x" /></span>
                    {/if}
                    {#if part === 'all' || part === 'head'}
                      <div class="board-col-head">
                        <button
                          class="board-col-toggle"
                          type="button"
                          data-column-toggle={column.id}
                          aria-label={t('sprintBoardColumnToggle', { column: columnName(column) })}
                          aria-expanded={!collapsedColumns.isCollapsed(column.id)}
                          onclick={() => collapsedColumns.toggle(column.id)}><Icon name="chevron" /></button
                        >
                        {#if column.is_done}<Icon name="check" />{/if}
                        <span class="board-col-name">{columnName(column)}</span>
                        <span class="board-col-n">{column.tasks.length}</span>
                        <span class="board-col-pts"
                          >{t('sprintBoardColumnPoints', { points: pointsOf(column.tasks) })}</span
                        >
                      </div>
                    {/if}
                    {#if part !== 'draft' && !collapsedColumns.isCollapsed(column.id)}
                      <!-- 完成の定義（components.css の .dod。kit.js の board）。完了の列にだけ畳んで置き、空なら出さない。本文は開くまで描かない -->
                      {#if column.is_done && part !== 'lane' && workspace.definitionOfDone !== null}
                        <details class="dod" bind:open={dodOpen}>
                          <summary>{t('dod')}</summary>
                          {#if dodOpen}<Markdown source={workspace.definitionOfDone} headingStart={2} />{/if}
                        </details>
                      {/if}
                      {#if part !== 'head'}
                        {#each column.tasks as task (task.id)}
                          <SprintCard
                            {task}
                            {highlightedStory}
                            onstoryhover={(id) => (hoveredStory = id)}
                            onstoryfocus={(id) => {
                              focusedStory = id;
                              // キーボードで親名へ移ったら、隙間で保ったポインタの強調より、フォーカスしたストーリーを先にする
                              if (id !== null) hoveredStory = undefined;
                            }}
                            onstoryfilter={(id) => void filterStory(id)}
                            href="{boardHref}?task={encodeURIComponent(task.id)}{cardFilterQuery === ''
                              ? ''
                              : `&${cardFilterQuery}`}"
                            edges={canWrite ? edgesOf(rowColumns, task.id) : null}
                            writable={canWrite}
                            clock={{ today: board.today, weekStart: board.week_start }}
                            hintId={KEY_HINT_ID}
                            dnd={canWrite ? dnd : undefined}
                            onmove={moveCard}
                            ondelete={canWrite ? (target, keyboard) => void removeCard(target, keyboard) : undefined}
                            attrs={cardAttrs}
                          />
                        {:else}
                          {#if part === 'all'}
                            <p class="board-empty">
                              {hiddenIn(column.id) > 0
                                ? t('boardColumnHidden', { count: hiddenIn(column.id) })
                                : t('sprintBoardColumnEmpty')}
                            </p>
                          {/if}
                        {/each}
                      {/if}
                    {/if}
                    {#if (part === 'all' || part === 'draft') && canWrite && !column.is_done}
                      <div class="board-col-draft" hidden={collapsedColumns.isCollapsed(column.id)}>
                        <DraftRow
                          bind:this={draftRows[column.id]}
                          draft={draftInputOf(column.id)}
                          keyshortcut={column.id === firstOpenColumnId ? ariaKeyshortcuts(NEW_TASK_KEY) : undefined}
                          label={t('sprintBoardAddTask', { task: t('task') })}
                          placeholder={t('sprintBoardAddTaskPlaceholder', { task: t('task') })}
                          describedby={storyId === null ? undefined : `story-create-${column.id}`}
                          name={t('sprintBoardAddTaskIn', { task: t('task'), column: columnName(column) })}
                          problem={cardTitleProblem}
                          create={(title) => addCard(column, title)}
                          ondiscard={() => clearDraftChoice(column.id)}
                        >
                          {#snippet attrs(sending)}
                            <DraftAttrs
                              column={columnName(column)}
                              {slug}
                              {workspaceId}
                              me={data.organization === null
                                ? null
                                : { id: data.organization.me.id, name: data.organization.me.name }}
                              clock={{ today: board.today, weekStart: board.week_start }}
                              bind:assignee={
                                () => draftChoiceOf(column.id).assignee,
                                (value) => setDraftChoice(column.id, { assignee: value })
                              }
                              bind:due={
                                () => draftChoiceOf(column.id).due, (value) => setDraftChoice(column.id, { due: value })
                              }
                              locked={sending ? t('treeAddSending') : undefined}
                            />
                          {/snippet}
                        </DraftRow>
                        {#if storyId !== null}<p class="action-note" id="story-create-{column.id}">
                            {t('sprintStoryCreateUnder', { story: t('story') })}
                          </p>{/if}
                      </div>
                    {/if}
                  </svelte:element>
                {/if}
              {/each}
            {/snippet}
            {#if filter.group === undefined}
              {@render boardRow(visibleColumns, 'all')}
            {:else}
              {@render boardRow(visibleColumns, 'head')}
              {#each lanes as lane (lane.id)}
                {@const name = laneName(lane.id, lane.label)}
                <section class="board-lane" aria-label={name} data-board-lane={lane.id}>
                  <h2 class="board-lane-head">
                    <button
                      class="board-lane-toggle"
                      type="button"
                      aria-expanded={!laneIsCollapsed(lane.id)}
                      onclick={() => toggleLane(lane.id)}
                    >
                      <span class="board-lane-label">
                        <Icon name="chevron" />
                        <span class="board-lane-name">{name}</span>
                        <span class="board-col-n">{t('boardGroupCount', { count: lane.count })}</span>
                      </span>
                    </button>
                  </h2>
                  {#if !laneIsCollapsed(lane.id)}
                    {@render boardRow(lane.columns, 'lane', lane.id)}
                  {/if}
                </section>
              {:else}
                <p class="board-empty board-lane-head">{t('filterResultNone')}</p>
              {/each}
              {@render boardRow(visibleColumns, 'draft')}
            {/if}
          </div>
        </div>
      </div>
    </div>
    {#if canWrite}
      <span class="visually-hidden" id={KEY_HINT_ID}>
        {t('sprintBoardKeyHint', { column: t('column'), done: t('done') })}
      </span>
    {/if}
  {/if}
  {#key workspace.id}
    <SprintExtendDialog
      bind:this={extendDialog}
      {slug}
      workspaceId={workspace.id}
      onextended={() => void invalidate('app:sprint-board')}
      ongone={() => void invalidate('app:sprint-board')}
    />
    <SprintDialog
      bind:this={editDialog}
      {slug}
      workspaceId={workspace.id}
      onsaved={() => void invalidate('app:sprint-board')}
      ongone={() => void invalidate('app:sprint-board')}
    />
    <SprintCloseDialog
      bind:this={closeDialog}
      {slug}
      workspaceId={workspace.id}
      onclosed={() => void closed()}
      ongone={() => void invalidate('app:sprint-board')}
    />
  {/key}
{/if}
