import type { Plugin } from 'vite';

export type BacklogVariant = 'B' | 'C';

function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0)
    throw new Error('バックログの形が変わりました。計測器を見直してください');
  return source.slice(0, at) + after + source.slice(at + before.length);
}

// 計測ビルドだけの成功経路の試作。製品の失敗・認証・再試行の実装ではない。
export function backlogLoadingSource(source: string, variant: BacklogVariant, reverse: boolean): string {
  const start = source.indexOf('  const [result, definitions] = await Promise.all([');
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('バックログの load の形が変わりました。計測器を見直してください');
  const calls = [
    "const primary = callOperation(backlogTree, { workspace_id: params.id, ...filterInput(filter) }, options).then((result) => { performance.mark('bench:primary'); return result; });",
    "const definitionRead = callOperation(categoryRepositoryList, { workspace_id: params.id }, options).then((result) => { performance.mark('bench:definitions'); return result; });",
  ];
  if (reverse) calls.reverse();
  return (
    source.slice(0, start) +
    calls.join('\n') +
    `
  const result = await primary;
  ${variant === 'B' ? 'const definitions = await definitionRead;' : ''}
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  performance.mark('bench:load');
  return {
    tree: result.ok ? result.data : null,
    loadedAt,
    readVersion,
    filter,
    definitions: ${variant === 'B' ? 'definitions.ok ? definitions.data : null' : 'definitionRead.then((value) => value.ok ? value.data : null)'},
  };` +
    source.slice(end)
  );
}

export function backlogLoadingComponent(source: string, variant: BacklogVariant): string {
  // 必要な表示位置も確認し、形が変わったときは別の指標を黙って測らない。
  for (const needle of ['let { data }: PageProps = $props();', 'definitions: data.definitions,', '<BacklogFilterBar'])
    if (!source.includes(needle)) throw new Error('バックログの表示が変わりました。計測器を見直してください');
  if (variant === 'C') {
    source = source.replaceAll('data.definitions', 'benchDefinitions');
    source = replaceOnce(
      source,
      'definitions: benchDefinitions,',
      'definitions: benchDefinitions,\n          benchDefinitionsPending: !benchDefinitionsReady,',
    );
    source = replaceOnce(
      source,
      'definitionsFailed={benchDefinitions === null}',
      'definitionsFailed={benchDefinitionsReady && benchDefinitions === null}\n          definitionsPending={!benchDefinitionsReady}',
    );
  }
  const state =
    variant === 'C'
      ? `
  let benchDefinitions = $state<Awaited<typeof data.definitions> | null>(null);
  let benchDefinitionsReady = $state(false);
  $effect(() => {
    const definitions = data.definitions;
    benchDefinitions = null;
    benchDefinitionsReady = false;
    let stale = false;
    void Promise.resolve(definitions).then((value) => {
      if (stale) return;
      benchDefinitions = value;
      benchDefinitionsReady = true;
    });
    return () => { stale = true; };
  });
`
      : '';
  source = replaceOnce(
    source,
    '  let { data }: PageProps = $props();',
    '  let { data }: PageProps = $props();\n' + state,
  );
  source = replaceOnce(
    source,
    '<script lang="ts">',
    `<script lang="ts">
  import { onMount as benchMount } from 'svelte';
  benchMount(() => {
    const reload = () => { void invalidate('app:backlog-tree'); };
    const filter = (event: Event) => {
      void applyFilter(filterFromParams(new URLSearchParams((event as CustomEvent<string>).detail)));
    };
    window.addEventListener('bench:reload', reload);
    window.addEventListener('bench:filter', filter);
    return () => {
      window.removeEventListener('bench:reload', reload);
      window.removeEventListener('bench:filter', filter);
    };
  });`,
  );
  return replaceOnce(
    source,
    '</script>',
    `</script>
<span id="bench-state" hidden
  data-read-version={data.readVersion}
  data-loaded-at={data.loadedAt}
  data-filter={JSON.stringify(data.filter)}
  data-definitions-ready={${variant === 'C' ? 'benchDefinitionsReady' : 'true'}}
></span>
`,
  );
}

export function backlogLoadingFilters(source: string): string {
  source = replaceOnce(source, '    definitionsFailed,', '    definitionsFailed,\n    definitionsPending = false,');
  source = replaceOnce(
    source,
    '    definitionsFailed: boolean;',
    '    definitionsFailed: boolean;\n    definitionsPending?: boolean;',
  );
  source = replaceOnce(
    source,
    '<select class="select" aria-label={select.label}',
    "<select class=\"select\" disabled={definitionsPending && (select.key === 'category' || select.key === 'repository')} aria-busy={definitionsPending && (select.key === 'category' || select.key === 'repository')} aria-label={select.label}",
  );
  return source;
}

export function backlogLoadingTaskEntry(source: string): string {
  source = replaceOnce(
    source,
    '    definitions: { categories: readonly DefinitionRef[]; repositories: readonly DefinitionRef[] } | null;',
    '    definitions: { categories: readonly DefinitionRef[]; repositories: readonly DefinitionRef[] } | null;\n    benchDefinitionsPending?: boolean;',
  );
  source = replaceOnce(
    source,
    '            options={repositoryOptions}',
    "            options={repositoryOptions}\n            locked={attrs?.benchDefinitionsPending ? t('loading') : undefined}",
  );
  return replaceOnce(
    source,
    '            locked={categoryLocked}',
    "            locked={attrs?.benchDefinitionsPending ? t('loading') : categoryLocked}",
  );
}

export function backlogLoadingPlugin(variant: BacklogVariant, reverse: boolean): Plugin {
  return {
    name: 'backlog-loading-benchmark-only',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/src/routes/[slug]/w/[id]/+page.ts')) return backlogLoadingSource(source, variant, reverse);
      if (id.endsWith('/src/routes/[slug]/w/[id]/+page.svelte')) return backlogLoadingComponent(source, variant);
      if (variant === 'C' && id.endsWith('/src/lib/components/BacklogFilterBar.svelte'))
        return backlogLoadingFilters(source);
      if (variant === 'C' && id.endsWith('/src/lib/components/TaskEntry.svelte'))
        return backlogLoadingTaskEntry(source);
    },
  };
}
