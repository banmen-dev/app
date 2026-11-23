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
  // locked に理由を渡すと（送っている間）、どちらも押せない
  let {
    slug,
    workspaceId,
    meId,
    clock,
    assignee = $bindable(null),
    due = $bindable(null),
    locked,
  }: {
    slug: string;
    workspaceId: string;
    meId: string | null;
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
  const assigneeActions = $derived(meId === null ? [] : [{ value: meId, text: t('assignToMe') }]);

  function chooseAssignee(value: string): void {
    if (value === '') {
      assignee = null;
      return;
    }
    const found = assigneeOptions.find((option) => option.value === value);
    // 「自分に割り当てる」は候補を読む前でも押せる。名前は候補から引き、引けなければ「自分」を出す
    assignee = { id: value, name: found?.text ?? t('assignToMe') };
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
  function commitDue(input: HTMLInputElement, close: () => void): void {
    if (!input.isConnected) return;
    const value = completeDate(input);
    if (value === null) return;
    due = value;
    close();
  }
</script>

<div
  class="draft-attrs"
  role="group"
  aria-label={t('draftAttrsLabel', { task: t('task'), assignee: t('assignee'), due: t('due') })}
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
              commitDue(event.currentTarget, close);
            }
          }}
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
