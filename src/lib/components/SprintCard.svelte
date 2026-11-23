<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import type { SprintBoardTask } from '../../shared/operations/sprint/index.ts';
  import { taskUpdate } from '../../shared/operations/task/index.ts';
  import { TASK_POINT_VALUES } from '../../shared/task.ts';
  import { callOperation } from '../api.ts';
  import { taskDetailHref, taskLinkAttrs } from '../drawer.svelte.ts';
  import { taskAttributes, type AttributeSaved } from '../task-attributes.svelte.ts';
  import { cardTitleFailure, taskTitleMessage } from '../task-title.ts';
  import { showToast } from '../toast.svelte.ts';
  import type { MoveDirection } from '../sprint-board.ts';
  import type { SprintDnd } from '../sprint-dnd.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import AttrChip from './AttrChip.svelte';
  import Avatar from './Avatar.svelte';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import RowMenu, { type RowMenuItem } from './RowMenu.svelte';

  // スプリントの画面のカード（kit.js の card）。題は `?task=<ID>` で詳細の引き出しを開くリンク、ポイント、担当、完了したカードの完了の印。
  // 書き込めるカードは完了したものも tabindex="0" で選べる。未完了カードは中のどこにフォーカスがあっても Alt と ← → で隣の列、
  // Alt と ↑ ↓ で列の中を動かす。同じ操作を、カードの右下の「⋯」（RowMenu）のメニューの「前の<列>へ」「上へ」「下へ」「次の<列>へ」でもできる。
  // 完了していないカードの操作は、「⋯」だけを出す。端の項目は aria-disabled（フォーカスを失わない）にし、端で Alt と矢印を押したときは画面に渡し、動かせないことを読み上げさせる。
  // 最後の完了でない列の「次の列へ」と Alt と → は、画面が完了にする（task-complete）。
  // 完了したカードも選べ、Alt と ← と「⋯」の前の列へで完了を戻す。戻せないカードも試せ、画面が理由を知らせる。
  // dnd を渡すと（書き込めるとき）、完了したカードを含めカード全体をつかめる。戻せないカードは not-allowed のカーソルで示す。
  // 題のリンクは draggable="false" で、リンクの既定のドラッグがカードのドラッグを奪わない。ボタンと「⋯」は押すだけで動き出さない。
  // 落とす位置の印は data-drop、つかんだ薄さは .is-dragging、落とした光は .is-dropped
  // attrs を渡すと（書き込めるとき）、ポイントと担当をバックログの行と同じチップ（AttrChip）にし、選んだら task-update、task-assign で
  // 1欄ずつ保存する（送り方と断られたときの戻し方は task-attributes.svelte.ts）。担当の窓は文字で候補を絞れ、先頭に「自分に割り当てる」を置く。
  // 題の横の鉛筆（ホバーとカードの中のフォーカスで出す）を押すと、題がその場で入力欄に替わり、Enter で task-update に送り、Esc で元の題に戻す。
  // 欄からフォーカスが外れたときも送る（引き出しの題と同じ）。完了したカードのチップと鉛筆、取り込んだタスクの鉛筆は押せず、理由が読める。
  // 保存が通ったら attrs.onpatch でカード（と列の合計）を直し、断られたら理由をトーストで知らせて元に戻し、attrs.onSaved で読み直す
  type CardAttrs = {
    slug: string;
    workspaceId: string;
    // 自分（「自分に割り当てる」で選ぶ人）。分からないときは null で、項目を出さない
    meId: string | null;
    // 盤を読み始めた時刻（performance.now()）。保存の後に古い読み込みが値を戻さないよう、送信列が比べる
    loadedAt: number;
    onpatch: (id: string, patch: Partial<Pick<SprintBoardTask, 'title' | 'points' | 'assignee'>>) => void;
    onSaved: () => Promise<void> | void;
    onStale: () => void;
  };
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
    attrs,
  }: {
    attrs?: CardAttrs;
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

  // ---- ポイントと担当のチップ（TaskEntry と同じ送信列） ----
  type PointsChoice = (typeof TASK_POINT_VALUES)[number] | null;
  const pointOptions = [
    { value: '', text: t('pointsUnsetTitle') },
    ...TASK_POINT_VALUES.map((value) => ({ value: String(value), text: t('pointsValue', { value }) })),
  ];
  const editor = $derived(attrs === undefined ? null : taskAttributes(attrs.slug, attrs.workspaceId, task.id));
  function patchSaved(saved: AttributeSaved): void {
    if (saved.field === 'points') attrs?.onpatch(task.id, { points: saved.task.points });
    else if (saved.field === 'assignee') {
      const assignee = saved.task.assignee;
      attrs?.onpatch(task.id, { assignee: assignee === null ? null : { id: assignee.id, name: assignee.name } });
    }
  }
  async function reload(): Promise<void> {
    try {
      await attrs?.onSaved();
    } catch {
      /* 送信の続きを妨げない */
    }
  }
  $effect(() => editor?.attach({ stale: () => attrs?.onStale(), rejected: reload, saved: patchSaved }));
  $effect(() => {
    const current = task;
    const at = attrs?.loadedAt ?? 0;
    const session = editor;
    // カードのポイントは DB の CHECK で選べる値に限られる（盤の応答の型は数のまま）
    untrack(() => session?.observe({ points: current.points as PointsChoice, assignee: current.assignee }, at));
  });
  const pointsShown = $derived(editor?.points.shown === undefined ? task.points : editor.points.shown);
  const assigneeShownId = $derived(editor?.assignee.shown ?? task.assignee?.id ?? '');
  const candidates = $derived(editor?.candidates ?? null);
  const candidatesFailed = $derived(editor?.candidatesFailed ?? false);
  const candidatesLoading = $derived(editor?.candidatesLoading ?? false);
  const assigneeOptions = $derived.by(() => {
    const options: { value: string; text: string }[] = [{ value: '', text: t('unassigned') }];
    for (const member of candidates ?? []) options.push({ value: member.id, text: member.name });
    // 今の担当が候補にいないときも、その人を残す。「離脱済み」と言えるのは、候補を読めて、その中にいないときだけ
    const current = task.assignee;
    if (current !== null && !options.some((option) => option.value === current.id)) {
      const left = candidates !== null && !candidatesFailed;
      options.push({ value: current.id, text: left ? `${current.name}${t('leftMember')}` : current.name });
    }
    return options;
  });
  const assigneeActions = $derived(attrs?.meId == null ? [] : [{ value: attrs.meId, text: t('assignToMe') }]);
  const assigneeShown = $derived(assigneeOptions.find((option) => option.value === assigneeShownId) ?? null);
  const assigneeText = $derived(
    assigneeShownId === '' ? t('assignee') : (assigneeShown?.text ?? task.assignee?.name ?? t('assignee')),
  );
  const pointsLockedReason = $derived(
    done ? t('taskSaveConflict', { task: t('task'), done: t('done'), points: t('points') }) : undefined,
  );
  const assigneeLockedReason = $derived(
    done ? t('taskAssigneeDone', { task: t('task'), done: t('done'), assignee: t('assignee') }) : undefined,
  );

  // ---- 題の書き換え ----
  const titleLockedReason = $derived(
    done
      ? t('cardTitleDone', { task: t('task'), done: t('done') })
      : task.is_imported
        ? t('cardTitleImported', { task: t('task') })
        : undefined,
  );
  let editingTitle = $state(false);
  let titleDraft = $state('');
  // 書き始めた時点の題（保存の expected）。直している間に盤が読み直されて別の人の題が入っても、黙って上書きしない
  let titleBase = '';
  // 送っている間に出す題（通るまで）。null は task.title をそのまま出す
  let titleSending = $state<string | null>(null);
  let titleInput = $state<HTMLInputElement>();
  let editButton = $state<HTMLButtonElement>();
  const titleShown = $derived(titleSending ?? task.title);
  // 直している間に書き込めなくなった（ワークスペースが終了した）ら、欄を閉じて書きかけを捨てる
  $effect(() => {
    if (attrs === undefined && untrack(() => editingTitle)) editingTitle = false;
  });

  async function beginTitle(): Promise<void> {
    if (titleLockedReason !== undefined) {
      // 押せない理由は title と読み上げのほか、押したときにも知らせる（指の画面には title が出ない）
      showToast(titleLockedReason, 'alert');
      return;
    }
    if (titleSending !== null) return;
    titleBase = task.title;
    titleDraft = task.title;
    editingTitle = true;
    await tick();
    titleInput?.focus();
    titleInput?.select();
  }

  // restoreFocus はキー（Enter と Esc）で終えたときだけ真。フォーカスが外れて終えたときは、移った先から奪わない
  async function endTitle(restoreFocus: boolean): Promise<void> {
    editingTitle = false;
    if (!restoreFocus) return;
    await tick();
    editButton?.focus();
  }

  // byKey は Enter で確定したとき。偽はフォーカスが外れたとき
  async function commitTitle(byKey: boolean): Promise<void> {
    if (!editingTitle) return;
    if (attrs === undefined) {
      await endTitle(byKey);
      return;
    }
    const next = titleDraft.trim();
    if (next === titleBase) {
      await endTitle(byKey);
      return;
    }
    const problem = taskTitleMessage(next);
    if (problem !== null) {
      showToast(problem, 'alert');
      // Enter では欄に留めて直してもらう。外れたときは欄へ引き戻さず、元の題に戻す
      if (!byKey) await endTitle(false);
      return;
    }
    // 送っている間にワークスペースが終了すると attrs は undefined に替わるので、送る前の配線を保って使う
    const target = attrs;
    titleSending = next;
    await endTitle(byKey);
    let failure: ReturnType<typeof cardTitleFailure> | null = null;
    try {
      const result = await callOperation(
        taskUpdate,
        { workspace_id: target.workspaceId, task_id: task.id, title: next, expected: { title: titleBase } },
        { slug: target.slug },
      );
      if (result.ok) {
        target.onpatch(task.id, { title: result.data.task.title });
        showToast(t('taskSaved'), 'check');
        return;
      }
      failure = cardTitleFailure(result, task.is_imported);
    } finally {
      // 応答の後の処理が失敗しても、送っている間の題を戻してカードを固めない
      titleSending = null;
    }
    showToast(failure.message, 'alert');
    if (failure.stale) target.onStale();
    try {
      await target.onSaved();
    } catch {
      /* 読み直しの失敗で、知らせた理由を隠さない */
    }
  }

  function titleKeydown(event: KeyboardEvent): void {
    // 欄の中のキーは、カードの移動（Alt と矢印）に渡さない
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitTitle(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void endTitle(true);
    }
  }
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
    if (event.target instanceof HTMLInputElement) return;
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
  {#if task.story !== null}
    <button
      class="card-parent is-action"
      data-story-filter={task.story.id}
      type="button"
      aria-label={t('sprintStoryFilterLabel', { story: t('story'), title: task.story.title })}
      onfocus={() => onstoryfocus?.(task.story!.id)}
      onblur={() => onstoryfocus?.(null)}
      onclick={() => onstoryfilter?.(task.story!.id)}><Icon name="flag" /> {task.story.title}</button
    >
  {/if}
  <!-- 横と真ん中のときは、押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す）。ページ全体の既定では taskLinkAttrs が reset を外し、先頭から表示する -->
  <!-- eslint-disable svelte/no-navigation-without-resolve -- href は画面が resolve した経路に ?task=<ID> を足したもの、またはその詳細ページ -->
  <div class="card-title-row">
    <!-- 書き換えている間も題のリンクを残して隠す（カードの名前 aria-labelledby が指す要素を消さない） -->
    <a
      class="card-title"
      id={titleId}
      href={taskDetailHref(href)}
      data-task-id={task.id}
      hidden={editingTitle}
      {...taskLinkAttrs()}
      draggable="false">{titleShown}</a
    >
    {#if editingTitle}
      <input
        class="input"
        type="text"
        autocomplete="off"
        aria-label={t('fieldTitle')}
        bind:this={titleInput}
        bind:value={titleDraft}
        onkeydown={titleKeydown}
        onblur={() => void commitTitle(false)}
      />
    {:else if attrs !== undefined}
      <button
        class="icon-btn card-edit-btn"
        type="button"
        bind:this={editButton}
        aria-label={t('cardTitleEditLabel', { title: titleShown })}
        title={titleLockedReason ?? t('cardTitleEditLabel', { title: titleShown })}
        aria-disabled={titleLockedReason !== undefined || titleSending !== null ? 'true' : undefined}
        aria-describedby={titleLockedReason !== undefined ? `${titleId}-locked` : undefined}
        onclick={() => void beginTitle()}><Icon name="pen" /></button
      >
      {#if titleLockedReason !== undefined}
        <span class="visually-hidden" id="{titleId}-locked">{titleLockedReason}</span>
      {/if}
    {/if}
  </div>
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
    {#if attrs !== undefined}
      <AttrChip
        attr={t('points')}
        text={pointsShown === null ? t('points') : t('pointsValue', { value: pointsShown })}
        unset={pointsShown === null}
        options={pointOptions}
        current={pointsShown === null ? '' : String(pointsShown)}
        onselect={(value) => editor?.points.choose(value === '' ? null : (Number(value) as PointsChoice), true)}
        locked={pointsLockedReason}
        points
      />
      <AttrChip
        attr={t('assignee')}
        text={assigneeText}
        unset={assigneeShownId === ''}
        options={assigneeOptions}
        current={assigneeShownId}
        onselect={(value) => editor?.assignee.choose(value, true)}
        locked={assigneeLockedReason}
        searchable
        actions={assigneeActions}
        onopen={() => void editor?.loadCandidates()}
        retry={candidatesFailed ? () => void editor?.loadCandidates() : undefined}
        retrying={candidatesLoading}
        failedNote={t('assigneeCandidatesFailed', { assignee: t('assignee') })}
        busy={candidatesLoading}
      >
        {#snippet lead()}
          {#if assigneeShownId === ''}
            <Avatar userId={null} decorative />
          {:else}
            <Avatar userId={assigneeShownId} name={assigneeShown?.text ?? ''} decorative />
          {/if}
        {/snippet}
      </AttrChip>
    {:else if task.points === null}
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
    {#if attrs !== undefined}
      <!-- 担当は、上のチップが出している -->
    {:else if task.assignee === null}
      <Avatar userId={null} />
    {:else}
      <Avatar userId={task.assignee.id} name={task.assignee.name} />
    {/if}
    <span class="card-end">
      {#if menuItems.length > 0}<RowMenu title={task.title} items={menuItems} />{/if}
      {#if done}
        <span class="hanko" role="img" aria-label={t('doneMarkLabel', { title: task.title, done: t('done') })}
          ><Icon name="check" /></span
        >
      {/if}
    </span>
  </div>
</article>
