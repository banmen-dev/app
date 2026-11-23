<script lang="ts">
  import { dueStatus } from '../../shared/due.ts';
  import { memberList } from '../../shared/operations/workspace/index.ts';
  import { callOperation } from '../api.ts';
  import { formatMonthDay } from '../format.ts';
  import { t } from '../vocabulary.svelte.ts';
  import AttrChip from './AttrChip.svelte';
  import Avatar from './Avatar.svelte';

  // 空の行（DraftRow）の下に並べる、作る前に選ぶ担当と期日のチップ（見本は design/kit.js の draftAttrs。#1501）。
  // 選んだ値は呼び出し側が持ち（bind:assignee、bind:due）、作れたら呼び出し側が空に戻す。ここでは保存しない。
  // 担当の候補は、開くたびにワークスペースのメンバー（member-list）を読み直す。カードの担当（SprintCard）と同じ、絞り込みの欄つきの窓。
  // 期日は日付の欄の窓で選ぶ。Enter か欄を離れたときに、日付として読めるときだけ決める（打ちかけの年では決めない）。
  // 期日の窓の Esc は取り消し（入れかけの日付を決めない）。決めた期日と同じ値のまま離れたときも閉じない（「クリア」を押せるように）。
  // locked に理由を渡すと（送っている間）、どちらも押せない
  let {
    column,
    slug,
    workspaceId,
    me,
    clock,
    assignee = $bindable(null),
    due = $bindable(null),
    locked,
  }: {
    // 列の名前（チップの組の読み上げの名前で、列を区別する）
    column: string;
    slug: string;
    workspaceId: string;
    // 自分（「自分に割り当てる」の値と名前。候補を読む前に選んでも名前を出せるように）
    me: { id: string; name: string } | null;
    clock: { today: string; weekStart: number };
    assignee?: { id: string; name: string } | null;
    due?: string | null;
    locked?: string;
  } = $props();

  let candidates = $state<readonly { id: string; name: string }[] | null>(null);
  let candidatesFailed = $state(false);
  let candidatesLoading = $state(false);
  let version = 0;

  async function loadCandidates(): Promise<void> {
    const mine = ++version;
    candidatesLoading = true;
    const result = await callOperation(memberList, { workspace_id: workspaceId }, { slug });
    if (mine !== version) return;
    candidatesLoading = false;
    candidatesFailed = !result.ok;
    candidates = result.ok ? result.data.members.map(({ id, name }) => ({ id, name })) : null;
  }

  const assigneeOptions = $derived.by(() => {
    const options: { value: string; text: string }[] = [{ value: '', text: t('unassigned') }];
    for (const member of candidates ?? []) options.push({ value: member.id, text: member.name });
    // 選んだ人が読み直した候補にいなくても、選んだ値は残す（送ると API が断る）
    const current = assignee;
    if (current !== null && !options.some((option) => option.value === current.id)) {
      options.push({ value: current.id, text: current.name });
    }
    return options;
  });
  const assigneeActions = $derived(me === null ? [] : [{ value: me.id, text: t('assignToMe') }]);

  function chooseAssignee(value: string): void {
    if (value === '') {
      assignee = null;
      return;
    }
    // 「自分に割り当てる」は候補を読む前でも押せるので、自分の名前は組織の自分の情報から引く
    if (me !== null && value === me.id) {
      assignee = { id: me.id, name: me.name };
      return;
    }
    const found = assigneeOptions.find((option) => option.value === value);
    if (found !== undefined) assignee = { id: value, name: found.text };
  }

  const dueView = $derived.by((): { text: string; tone?: 'danger' | 'warn' } | null => {
    if (due === null) return null;
    try {
      const date = formatMonthDay(due);
      const status = dueStatus(due, clock.today, clock.weekStart);
      if (status === 'overdue') return { text: t('dueOverdue', { due: t('due'), date }), tone: 'danger' };
      if (status === 'today') return { text: t('dueToday'), tone: 'warn' };
      if (status === 'this_week') return { text: t('dueThisWeek', { date }), tone: 'warn' };
      return { text: date };
    } catch {
      return { text: due };
    }
  });

  // 日付の欄の値が、決めてよい日付か（打ちかけの年や、読めない入力は決めない）
  function completeDate(input: HTMLInputElement): string | null {
    const value = input.value;
    if (input.validity.badInput || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    return Number(value.slice(0, 4)) < 1000 ? null : value;
  }
  // Esc で窓を閉じる間の blur では決めない（AttrChip が閉じる前にチップへフォーカスを戻すので、欄はまだ DOM にある）
  let cancelling = false;
  // カレンダーで選んだ日付は change で値だけを決め、窓は閉じない（Chrome は月や日を打っている途中でも完全な日付の change を出すので、
  // 閉じると残りの入力が届かない）。窓を閉じるのは Enter と、欄を離れたときだけ
  function pickDue(input: HTMLInputElement): void {
    if (cancelling) return;
    const value = completeDate(input);
    if (value !== null) due = value;
  }
  // viaEnter は Enter で決めたとき。同じ値でも閉じる。欄を離れたときは、決めた値と同じなら閉じない
  // （開き直して「クリア」へ移るときの blur で窓を閉じると、「クリア」が押せない）
  function commitDue(input: HTMLInputElement, close: () => void, viaEnter = false): void {
    if (!input.isConnected || cancelling) return;
    const value = completeDate(input);
    if (value === null) return;
    if (value === due) {
      if (viaEnter) close();
      return;
    }
    due = value;
    close();
  }
</script>

<div
  class="draft-attrs"
  role="group"
  aria-label={t('draftAttrsLabel', { task: t('task'), assignee: t('assignee'), due: t('due'), column })}
>
  <AttrChip
    attr={t('assignee')}
    text={assignee === null ? t('assignee') : assignee.name}
    unset={assignee === null}
    options={assigneeOptions}
    current={assignee?.id ?? ''}
    onselect={chooseAssignee}
    {locked}
    searchable
    actions={assigneeActions}
    onopen={() => void loadCandidates()}
    retry={candidatesFailed ? () => void loadCandidates() : undefined}
    retrying={candidatesLoading}
    failedNote={t('assigneeCandidatesFailed', { assignee: t('assignee') })}
    busy={candidatesLoading}
  >
    {#snippet lead()}
      {#if assignee === null}
        <Avatar userId={null} decorative />
      {:else}
        <Avatar userId={assignee.id} name={assignee.name} decorative />
      {/if}
    {/snippet}
  </AttrChip>
  <AttrChip
    attr={t('due')}
    text={dueView === null ? t('due') : dueView.text}
    unset={dueView === null}
    tone={dueView?.tone}
    options={[]}
    current={due ?? ''}
    onselect={(value) => (due = value === '' ? null : value)}
    {locked}
  >
    {#snippet panel(close)}
      <div>
        <input
          class="input"
          type="date"
          aria-label={t('due')}
          value={due ?? ''}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              commitDue(event.currentTarget, close, true);
            } else if (event.key === 'Escape') {
              // 窓を閉じるのは AttrChip。閉じる間の blur で決めないよう、次の描画まで印を立てる
              cancelling = true;
              requestAnimationFrame(() => (cancelling = false));
            }
          }}
          onchange={(event) => pickDue(event.currentTarget)}
          onblur={(event) => commitDue(event.currentTarget, close)}
        />
        {#if due !== null}
          <button
            class="menu-item"
            type="button"
            onclick={() => {
              due = null;
              close();
            }}>{t('dueClear')}</button
          >
        {/if}
      </div>
    {/snippet}
  </AttrChip>
</div>
