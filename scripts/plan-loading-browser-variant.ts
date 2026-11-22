import type { Plugin } from 'vite';

export type PlanLoadingBrowserVariant = 'B' | 'C';

const currentReads = `  const [result, summaryResult] = await Promise.all([
    callOperation(sprintList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }),
    callOperation(planSummary, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }),
  ]);
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  if (isUnauthenticated(summaryResult)) redirect(307, loginUrl(url));
  return { plan: result.ok ? result.data : null, summary: summaryResult.ok ? summaryResult.data : null };`;

function replaceOnce(source: string, before: string, after: string): string {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) >= 0)
    throw new Error('計画ページの形が変わりました。計測器を見直してください');
  return source.slice(0, start) + after + source.slice(start + before.length);
}

export function planLoadingBrowserLoad(source: string, variant: PlanLoadingBrowserVariant): string {
  const load = 'export const load: PageLoad';
  source = replaceOnce(source, load, `let nextBenchGeneration = 0;\n\n${load}`);
  const read =
    variant === 'B'
      ? currentReads.replace('return { plan:', 'return { benchGeneration, plan:')
      : `  const listRead = callOperation(sprintList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  const summaryRead = callOperation(planSummary, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch });
  const result = await listRead;
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  return { benchGeneration, plan: result.ok ? result.data : null, summary: summaryRead };`;
  const measured = read
    .replace(
      '  return { benchGeneration',
      '  performance.mark("bench:load:" + benchGeneration);\n  return { benchGeneration',
    )
    .replace(
      'callOperation(sprintList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch })',
      'callOperation(sprintList, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }).then((value) => { performance.mark("bench:list-response:" + benchGeneration); return value; })',
    )
    .replace(
      'callOperation(planSummary, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch })',
      'callOperation(planSummary, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }).then((value) => { performance.mark("bench:summary-response:" + benchGeneration); return value; })',
    );
  return replaceOnce(source, currentReads, `  const benchGeneration = ++nextBenchGeneration;\n${measured}`);
}

export function planLoadingBrowserPage(source: string, variant: PlanLoadingBrowserVariant): string {
  const imports = "  import { tick } from 'svelte';";
  source = replaceOnce(
    source,
    imports,
    `  import { onMount, tick } from 'svelte';

  onMount(() => {
    const reread = (event: Event) => {
      const { detail } = event as CustomEvent<unknown>;
      if (detail === 'app:sprints' || detail === 'app:backlog-tree') void invalidate(detail);
    };
    window.addEventListener('bench:plan-invalidate', reread);
    return () => window.removeEventListener('bench:plan-invalidate', reread);
  });`,
  );
  const summaryDeclaration = '  const summary = $derived(data.summary);';
  if (variant === 'C') {
    source = replaceOnce(
      source,
      summaryDeclaration,
      `  type BenchSummary = Extract<Awaited<typeof data.summary>, { ok: true }>['data'];
  let benchSettledSummary = $state<{ generation: number; value: BenchSummary | null } | null>(null);
  const benchCurrentSummary = $derived(
    benchSettledSummary?.generation === data.benchGeneration ? benchSettledSummary : null,
  );
  const summary = $derived(benchCurrentSummary?.value ?? null);
  const benchSummaryPending = $derived(benchCurrentSummary === null);

  $effect(() => {
    const generation = data.benchGeneration;
    const summaryRead = data.summary;
    let active = true;
    void summaryRead.then((result) => {
      if (!active || generation !== data.benchGeneration) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      benchSettledSummary = { generation, value: result.ok ? result.data : null };
    }, () => {
      if (active && generation === data.benchGeneration) benchSettledSummary = { generation, value: null };
    });
    return () => { active = false; };
  });`,
    );
    source = replaceOnce(
      source,
      `      <PlanVelocity velocity={summary.velocity} />
    {:else}`,
      `      <PlanVelocity velocity={summary.velocity} />
    {:else if benchSummaryPending}
      <div class="callout" role="status" aria-busy="true">{t('loading')}</div>
    {:else}`,
    );
    source = replaceOnce(
      source,
      `    {#if plan.sprints.length === 0}
      <EmptyState icon="calendar" title={lanesEmptyTitle} text={lanesEmptyText} />`,
      `    {#if plan.sprints.length === 0}
      {#if benchSummaryPending}
        <EmptyState icon="calendar" title={t('planLanesEmptyTitle', sprintWords)} />
      {:else}
        <EmptyState icon="calendar" title={lanesEmptyTitle} text={lanesEmptyText} />
      {/if}`,
    );
  } else {
    replaceOnce(source, summaryDeclaration, summaryDeclaration);
  }
  return replaceOnce(
    source,
    '{:else if workspace && plan !== null}\n  <PageHead',
    `{:else if workspace && plan !== null}
  <span id="bench-plan-state" hidden
    data-generation={data.benchGeneration}
    data-summary-ready={summary !== null}
    data-list-empty={plan.sprints.length === 0}
  ></span>
  <PageHead`,
  );
}

// 製品コードの書き換えを伴わないブラウザ計測専用変換。
export function planLoadingBrowserPlugin(variant: PlanLoadingBrowserVariant): Plugin {
  return {
    name: 'plan-loading-browser-benchmark-only',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/src/routes/[slug]/w/[id]/plan/+page.ts')) return planLoadingBrowserLoad(source, variant);
      if (id.endsWith('/src/routes/[slug]/w/[id]/plan/+page.svelte')) return planLoadingBrowserPage(source, variant);
    },
  };
}
