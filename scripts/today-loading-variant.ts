import type { Plugin } from 'vite';

export type TodayVariant = 'B' | 'C';

// 計測ビルドだけに適用する。実際の画面ファイルは書き換えない。
// C は成功経路の待ちを分ける試作であり、製品のエラー・再試行実装ではない。
export function todayLoadingSource(source: string, variant: TodayVariant, reverse: boolean): string {
  const start = source.indexOf('  const [todayResult, firstStepsResult] = await Promise.all([');
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('today load の形が変わりました。計測器を見直してください');
  const calls = [
    "const primary = callOperation(today, {}, { slug: params.slug, fetcher: fetch }).then((result) => { performance.mark('bench:primary'); return result; });",
    "const secondary = callOperation(firstSteps, {}, { slug: params.slug, fetcher: fetch }).then((result) => { performance.mark('bench:secondary'); return result; });",
  ];
  if (reverse) calls.reverse();
  return (
    source.slice(0, start) +
    calls.join('\n') +
    `
  const todayResult = await primary;
  ${variant === 'B' ? 'const firstStepsResult = await secondary;' : ''}
  if (isUnauthenticated(todayResult)) redirect(307, loginUrl(url));
  performance.mark('bench:load');
  return {
    today: todayResult.ok ? todayResult.data : null,
    firstSteps: ${variant === 'B' ? 'firstStepsResult.ok ? firstStepsResult.data : null' : 'secondary.then((result) => result.ok ? result.data : null)'},
  };` +
    source.slice(end)
  );
}

export function todayLoadingComponent(source: string, variant: TodayVariant): string {
  const begin = source.indexOf('  {#if data.organization !== null && data.firstSteps');
  const end = source.indexOf('\n  {/if}', begin);
  if (begin < 0 || end < 0) throw new Error('first-steps の表示が変わりました。計測器を見直してください');
  if (variant === 'C') {
    const block = source.slice(begin, end + '\n  {/if}'.length).replaceAll('data.firstSteps', 'benchSteps');
    source =
      source.slice(0, begin) +
      '{#await data.firstSteps then benchSteps}\n' +
      block +
      '\n{/await}' +
      source.slice(end + '\n  {/if}'.length);
  }
  // ページの実際の invalidate を呼ぶための計測専用入口。製品ビルドには入らない。
  return source.replace(
    '<script lang="ts">',
    `<script lang="ts">
  import { onMount as benchMount } from 'svelte';
  benchMount(() => {
    const reload = () => { void invalidate('app:today'); };
    window.addEventListener('bench:reload', reload);
    return () => window.removeEventListener('bench:reload', reload);
  });`,
  );
}

export function todayLoadingPlugin(variant: TodayVariant, reverse: boolean): Plugin {
  return {
    name: 'today-loading-benchmark-only',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/src/routes/[slug]/+page.ts')) return todayLoadingSource(source, variant, reverse);
      if (id.endsWith('/src/routes/[slug]/+page.svelte')) return todayLoadingComponent(source, variant);
    },
  };
}
