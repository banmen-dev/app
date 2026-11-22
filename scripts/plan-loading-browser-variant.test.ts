import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compile } from 'svelte/compiler';
import {
  planLoadingBrowserLoad,
  planLoadingBrowserPage,
  type PlanLoadingBrowserVariant,
} from './plan-loading-browser-variant.ts';

const route = new URL('../src/routes/[slug]/w/[id]/plan/', import.meta.url);
const loadSource = readFileSync(new URL('+page.ts', route), 'utf8');
const pageSource = readFileSync(new URL('+page.svelte', route), 'utf8');
const keys = ['app:sprints', 'app:backlog-tree'];
const listSuccess = { ok: true, data: { sprints: [] } };
const summarySuccess = { ok: true, data: { lanes: [], epics: [], velocity: { sprints: [] } } };

function loadWithReads(variant: PlanLoadingBrowserVariant) {
  const calls: string[] = [];
  const dependencies: string[] = [];
  const list = Promise.withResolvers<typeof listSuccess>();
  const summary = Promise.withResolvers<typeof summarySuccess>();
  const transformed = planLoadingBrowserLoad(loadSource, variant)
    .replace(/^import .*\n/gm, '')
    .replace('export const load: PageLoad =', 'return');
  const create = new Function('callOperation', 'sprintList', 'planSummary', 'isUnauthenticated', transformed);
  const load = create(
    (operation: string) => {
      calls.push(operation);
      return operation === 'sprint-list' ? list.promise : summary.promise;
    },
    'sprint-list',
    'plan-summary',
    () => false,
  );
  return {
    run: () => load({ params: { id: 'workspace', slug: 'org' }, depends: (key: string) => dependencies.push(key) }),
    calls,
    dependencies,
    list,
    summary,
  };
}

test('B は一覧と集計をこの順で始め、集計も完了してから返る', async () => {
  const fixture = loadWithReads('B');
  const pending = fixture.run();
  assert.deepEqual(fixture.calls, ['sprint-list', 'plan-summary']);
  assert.deepEqual(fixture.dependencies, keys);
  fixture.list.resolve(listSuccess);
  const immediate = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve('waiting')))]);
  assert.equal(immediate, 'waiting');
  fixture.summary.resolve(summarySuccess);
  assert.deepEqual(await pending, { benchGeneration: 1, plan: listSuccess.data, summary: summarySuccess.data });
});

test('C は同じ順で両方始め、一覧が返ると集計の結果を待たずに読み直しの世代を進める', async () => {
  const fixture = loadWithReads('C');
  const pending = fixture.run();
  assert.deepEqual(fixture.calls, ['sprint-list', 'plan-summary']);
  assert.deepEqual(fixture.dependencies, keys);
  fixture.list.resolve(listSuccess);
  const result = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve('waiting')))]);
  assert.notEqual(result, 'waiting');
  assert.equal(result.benchGeneration, 1);
  assert.deepEqual(result.plan, listSuccess.data);
  const immediate = await Promise.race([
    result.summary,
    new Promise((resolve) => setImmediate(() => resolve('waiting'))),
  ]);
  assert.equal(immediate, 'waiting');
  const next = await fixture.run();
  assert.equal(next.benchGeneration, 2);
  fixture.summary.resolve(summarySuccess);
  assert.equal(await result.summary, summarySuccess);
  assert.equal(await next.summary, summarySuccess);
});

test('B と C の DOM 計測目印と無効化イベントはコンパイルでき、C の表示は現世代の集計に限る', () => {
  const B = planLoadingBrowserPage(pageSource, 'B');
  const C = planLoadingBrowserPage(pageSource, 'C');
  for (const source of [B, C]) {
    assert.doesNotThrow(() => compile(source, { filename: '+page.svelte', generate: 'client' }));
    assert.match(source, /id="bench-plan-state" hidden\s+data-generation=\{data\.benchGeneration\}/);
    assert.match(source, /data-summary-ready=\{summary !== null\}/);
    assert.match(source, /data-list-empty=\{plan\.sprints\.length === 0\}/);
    assert.match(
      source,
      /if \(detail === 'app:sprints' \|\| detail === 'app:backlog-tree'\) void invalidate\(detail\)/,
    );
    assert.match(source, /window\.removeEventListener\('bench:plan-invalidate', reread\)/);
  }
  assert.doesNotMatch(B, /benchSummaryPending/);
  assert.match(C, /benchSettledSummary\?\.generation === data\.benchGeneration \? benchSettledSummary : null/);
  assert.match(C, /if \(!active \|\| generation !== data\.benchGeneration\) return;/);
  assert.match(C, /return \(\) => \{ active = false; \};/);
  assert.match(C, /\{:else if benchSummaryPending\}\s*<div[^>]+aria-busy="true"/);
  assert.match(C, /\{#if plan\.sprints\.length === 0\}\s*\{#if benchSummaryPending\}/);
});

test('元の load または空表示が変われば比較条件を読み直すよう停止する', () => {
  assert.throws(() => planLoadingBrowserLoad(loadSource.replace('Promise.all', 'Promise.allSettled'), 'B'), /見直して/);
  assert.throws(
    () => planLoadingBrowserPage(pageSource.replace('title={lanesEmptyTitle}', 'title=""'), 'C'),
    /見直して/,
  );
});
