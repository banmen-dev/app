import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import {
  backlogLoadingComponent,
  backlogLoadingFilters,
  backlogLoadingPlugin,
  backlogLoadingSource,
  backlogLoadingTaskEntry,
} from './backlog-loading-variant.ts';

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const loadSource = read('routes/[slug]/w/[id]/+page.ts');
const component = read('routes/[slug]/w/[id]/+page.svelte');
const filters = read('lib/components/BacklogFilterBar.svelte');
const taskEntry = read('lib/components/TaskEntry.svelte');

for (const variant of ['B', 'C'] as const)
  for (const reverse of [false, true]) {
    test(`${variant}/${reverse}: 主と従2つを同時に開始し、指定した応答だけを待つ`, async () => {
      const code = ts.transpileModule(backlogLoadingSource(loadSource, variant, reverse), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText;
      type Values = {
        tree: unknown;
        definitions: unknown;
        teamTotal: unknown;
        filter: unknown;
        readVersion: number;
        loadedAt: number;
      };
      const exports: Record<string, (args: unknown) => Promise<Values>> = {};
      const pending = new Map<string, (value: unknown) => void>();
      const called: { name: string; input: unknown }[] = [];
      const marks: string[] = [];
      const filter = { q: '計測', category: 'category-id' };
      runInNewContext(code, {
        exports,
        performance: { now: () => 17, mark: (name: string) => marks.push(name) },
        require: () => ({
          backlogTree: 'tree',
          categoryRepositoryList: 'definitions',
          experienceTeamTotal: 'experience',
          isUnauthenticated: () => false,
          startBacklogRead: () => 23,
          filterFromParams: () => filter,
          filterInput: () => ({ query: '計測', category_id: 'category-id' }),
          callOperation: (name: string, input: unknown) => {
            called.push({ name, input });
            return new Promise((resolve) => pending.set(name, resolve));
          },
        }),
      });
      const result = exports.load!({
        params: { slug: 'bench', id: 'workspace' },
        url: new URL('https://example.test/?q=計測'),
        depends: () => {},
      });
      assert.deepEqual(
        called.map((x) => x.name),
        reverse ? ['experience', 'definitions', 'tree'] : ['tree', 'definitions', 'experience'],
      );
      assert.equal(
        JSON.stringify(called.find((x) => x.name === 'tree')!.input),
        JSON.stringify({ workspace_id: 'workspace', query: '計測', category_id: 'category-id' }),
      );
      let returned = false;
      void result.then(() => {
        returned = true;
      });
      pending.get('tree')!({ ok: true, data: { tasks: ['target'] } });
      await setImmediate();
      assert.equal(returned, variant === 'C');
      assert.equal(marks.includes('bench:load'), variant === 'C');
      pending.get('definitions')!({ ok: true, data: { categories: [1], repositories: [2] } });
      await setImmediate();
      assert.equal(returned, variant === 'C');
      pending.get('experience')!({ ok: true, data: { total: 19 } });
      const values = await result;
      assert.equal(JSON.stringify(await values.definitions), JSON.stringify({ categories: [1], repositories: [2] }));
      assert.equal(await values.teamTotal, 19);
      assert.equal(JSON.stringify(values.tree), JSON.stringify({ tasks: ['target'] }));
      assert.equal(values.filter, filter);
      assert.equal(values.loadedAt, 17);
      assert.equal(values.readVersion, 23);
      for (const mark of ['bench:load', 'bench:primary', 'bench:definitions', 'bench:experience'])
        assert.ok(marks.includes(mark));
    });
  }

for (const variant of ['B', 'C'] as const)
  test(`${variant}: 実際の画面と計測状態・再読み取り・絞り込みの入口をコンパイルできる`, () => {
    const source = backlogLoadingComponent(component, variant);
    for (const text of [
      '<BacklogFilterBar',
      '<TaskEntry',
      'id="bench-state"',
      'data-read-version=',
      'data-filter=',
      'data-definitions-ready=',
      "invalidate('app:backlog-tree')",
      'applyFilter(filterFromParams(new URLSearchParams',
    ])
      assert.ok(source.includes(text), text);
    assert.equal(source.includes('benchDefinitionsPending: !benchDefinitionsReady'), variant === 'C');
    assert.equal(source.includes('definitionsPending={!benchDefinitionsReady}'), variant === 'C');
    assert.doesNotThrow(() => compile(source, { filename: 'Backlog.svelte', runes: true }));
  });

test('未取得中は区分・リポジトリだけを待たせる部品をコンパイルできる', () => {
  const transformed = backlogLoadingFilters(filters);
  assert.ok(
    transformed.includes("disabled={definitionsPending && (select.key === 'category' || select.key === 'repository')}"),
  );
  assert.doesNotThrow(() => compile(transformed, { filename: 'BacklogFilterBar.svelte', runes: true }));
  const transformedEntry = backlogLoadingTaskEntry(taskEntry);
  assert.ok(transformedEntry.includes("locked={attrs?.benchDefinitionsPending ? t('loading') : categoryLocked}"));
  assert.doesNotThrow(() => compile(transformedEntry, { filename: 'TaskEntry.svelte', runes: true }));
});

test('変換対象の形が変わったら測定を停止する', () => {
  for (const transform of [
    () => backlogLoadingSource('unknown', 'C', false),
    () => backlogLoadingComponent('unknown', 'C'),
    () => backlogLoadingFilters('unknown'),
    () => backlogLoadingTaskEntry('unknown'),
  ])
    assert.throws(transform, /計測器を見直して/);
});

test('pluginは対象パスだけ変換し、query付きや別画面に適用しない', () => {
  const transform = backlogLoadingPlugin('C', false).transform as (source: string, id: string) => string | undefined;
  for (const [path, source] of [
    ['routes/[slug]/w/[id]/+page.ts', loadSource],
    ['routes/[slug]/w/[id]/+page.svelte', component],
    ['lib/components/BacklogFilterBar.svelte', filters],
    ['lib/components/TaskEntry.svelte', taskEntry],
  ])
    assert.ok(transform(source!, `/project/src/${path}`));
  for (const id of [
    '/project/src/routes/[slug]/w/[id]/+page.svelte?svelte&type=style',
    '/project/src/routes/[slug]/w/[id]/+page.ts?raw',
    '/project/src/routes/[slug]/+page.ts',
    '/project/src/routes/[slug]/w/[id]/+page.server.ts',
    '/project/src/routes/[slug]/w/[id]/+layout.svelte',
    '/project/src/lib/components/TaskEntry.svelte?raw',
  ])
    assert.equal(transform('対象外', id), undefined, id);
  const bTransform = backlogLoadingPlugin('B', false).transform as (source: string, id: string) => string | undefined;
  assert.equal(bTransform(taskEntry, '/project/src/lib/components/TaskEntry.svelte'), undefined);
  assert.equal(bTransform(filters, '/project/src/lib/components/BacklogFilterBar.svelte'), undefined);
});
