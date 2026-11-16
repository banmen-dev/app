<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { resolve } from '$app/paths';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { myToday } from '../../shared/operations/organization/my-today.ts';
  import { callOperation } from '../api.ts';
  import { organizationLabel } from '../organization-label.ts';
  import { todaySections } from '../today-sections.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import Pane from './Pane.svelte';
  import Section from './Section.svelte';
  import TaskEntry from './TaskEntry.svelte';

  // initial の値は見本・単体テストでも使える。実画面は面の中で取得し、組織の入口を待たせない。
  let { today: initialToday }: { today?: OutputOf<typeof myToday> | null } = $props();
  let today = $state<OutputOf<typeof myToday> | null | undefined>(untrack(() => initialToday));
  let generation = 0;
  onMount(() => {
    void load();
    return () => {
      generation++;
    };
  });
  async function load(): Promise<void> {
    const token = ++generation;
    const result = await callOperation(myToday, {});
    if (token !== generation) return;
    today = result.ok ? result.data : null;
  }
  const sections = $derived(todaySections(today?.tasks ?? []));
  const groups = $derived([
    { key: 'overdue', title: t('overdue'), tasks: sections.overdue },
    { key: 'today', title: t('sectionToday'), tasks: sections.today },
    { key: 'delegated', title: t('sectionDelegated'), tasks: sections.delegated },
    { key: 'week', title: t('weekDue'), tasks: sections.week },
    { key: 'sprint', title: t('sprintInProgress'), tasks: sections.sprint },
    { key: 'done', title: t('doneToday'), tasks: sections.done },
  ]);
  let retrying = $state(false);
  let retryFailed = $state(false);
  async function retry(): Promise<void> {
    if (retrying) return;
    const focused = document.activeElement;
    retrying = true;
    retryFailed = false;
    try {
      await load();
    } finally {
      retrying = false;
      retryFailed = today === null;
    }
    await tick();
    if (
      today !== null &&
      today !== undefined &&
      (document.activeElement === focused || document.activeElement === document.body)
    ) {
      document.getElementById('p-my-today')?.focus();
    }
  }
</script>

<Pane id="p-my-today" title={t('paneMyToday')} busy={today === undefined || retrying}>
  {#if today === undefined}
    <div class="skeleton" aria-hidden="true">
      <span class="skeleton-line is-block"></span>
      <span class="skeleton-line is-block"></span>
      <span class="skeleton-line is-block"></span>
    </div>
  {:else if today === null}
    <div class="callout is-warn"><Icon name="alert" /><span role="alert">{t('myTodayLoadFailed')}</span></div>
    <div class="form-actions">
      <button class="btn" type="button" aria-disabled={retrying} onclick={() => void retry()}>{t('retry')}</button>
      <span class="field-hint" role="status">{retrying ? t('retrying') : retryFailed ? t('retryFailed') : ''}</span>
    </div>
  {:else}
    {#if today.omitted_organizations > 0}
      <p class="gate-note">{t('myTodayOmitted', { count: today.omitted_organizations })}</p>
    {/if}
    {#each today.failed_organizations as organization (organization.slug)}
      <p class="gate-note">
        <a href={resolve('/[slug]', { slug: organization.slug })}>
          {t('myTodayFailedOrganization', { name: organizationLabel(organization) })}
        </a>
      </p>
    {/each}
    {#if today.tasks.length === 0 && today.failed_organizations.length === 0}
      <p class="book-empty">{t('myTodayEmpty')}</p>
    {/if}
    {#each groups as group (group.key)}
      {#if group.tasks.length > 0}
        <Section
          id={`my-today-${group.key}`}
          title={group.title}
          level={3}
          count={group.tasks.length}
          folded={group.key === 'sprint'}
        >
          <div class="book">
            {#each group.tasks as task (`${task.organization.slug}:${task.id}`)}
              <TaskEntry
                task={{ ...task, category: null, can_delete: false }}
                clock={{ today: task.today, weekStart: task.week_start }}
                done={task.completed_at !== null}
                canComplete={false}
                workspaceId={task.workspace_id}
                workspaceName={task.workspace_name}
                organization={{ slug: task.organization.slug, name: organizationLabel(task.organization) }}
                metaChip={group.key === 'week' && task.due_on === task.today ? t('dueIsToday') : undefined}
                metaText={group.key === 'delegated' && task.delegatee !== null
                  ? t('delegatedTo', { delegatee: t('delegatee'), name: task.delegatee.name })
                  : task.carry_days > 0
                    ? t('carryDays', { days: task.carry_days })
                    : undefined}
              />
            {/each}
          </div>
        </Section>
      {/if}
    {/each}
  {/if}
</Pane>
