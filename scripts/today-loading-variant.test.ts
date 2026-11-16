import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { todayLoadingSource, todayLoadingComponent, todayLoadingPlugin } from './today-loading-variant.ts';

const loadSource = readFileSync(new URL('../src/routes/[slug]/+page.ts', import.meta.url), 'utf8');
const component = readFileSync(new URL('../src/routes/[slug]/+page.svelte', import.meta.url), 'utf8');
for (const variant of ['B', 'C'] as const)
  for (const reverse of [false, true]) {
    test(`${variant}/${reverse}: 実際の load の試作が発行順と待つ対象を保つ`, async () => {
      const code = ts.transpileModule(todayLoadingSource(loadSource, variant, reverse), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText;
      const exports: Record<string, (args: unknown) => Promise<{ today: unknown; firstSteps: unknown }>> = {};
      const pending = new Map<string, (value: unknown) => void>();
      const called: string[] = [];
      runInNewContext(code, {
        exports,
        performance,
        require: () => ({
          today: 'today',
          firstSteps: 'first-steps',
          isUnauthenticated: () => false,
          callOperation: (name: string) => {
            called.push(name);
            return new Promise((resolve) => pending.set(name, resolve));
          },
        }),
      });
      const result = exports.load!({ params: { slug: 'bench' }, depends: () => {} });
      assert.deepEqual(called, reverse ? ['first-steps', 'today'] : ['today', 'first-steps']);
      let returned = false;
      void result.then(() => {
        returned = true;
      });
      pending.get('today')!({ ok: true, data: { tasks: [] } });
      await setImmediate();
      assert.equal(returned, variant === 'C');
      pending.get('first-steps')!({ ok: true, data: { role: 'member', steps: [1] } });
      const values = await result;
      assert.equal(JSON.stringify(await values.firstSteps), JSON.stringify({ role: 'member', steps: [1] }));
      assert.equal(JSON.stringify(values.today), JSON.stringify({ tasks: [] }));
    });
  }
for (const variant of ['B', 'C'] as const)
  test(`${variant}: 手順の表示を残す計測用部品がコンパイルできる`, () => {
    const source = todayLoadingComponent(component, variant);
    assert.ok(source.includes('<FirstSteps'));
    assert.equal(source.includes('{#await data.firstSteps then benchSteps}'), variant === 'C');
    assert.doesNotThrow(() => compile(source, { filename: 'Today.svelte', runes: true }));
  });
test('load・手順の形が変わったら別の画面を黙って測らない', () => {
  assert.throws(() => todayLoadingSource('unknown', 'C', false), /計測器を見直して/);
  assert.throws(() => todayLoadingComponent('unknown', 'C'), /計測器を見直して/);
});

test('計測プラグインは対象のload・部品だけを変換し、query付きや別経路に適用しない', () => {
  const transform = todayLoadingPlugin('C', false).transform as (source: string, id: string) => string | undefined;
  assert.ok(transform(loadSource, '/project/src/routes/[slug]/+page.ts')?.includes('bench:primary'));
  assert.ok(transform(component, '/project/src/routes/[slug]/+page.svelte')?.includes('bench:reload'));
  for (const id of [
    '/project/src/routes/[slug]/+page.svelte?svelte&type=style',
    '/project/src/routes/[slug]/+page.ts?raw',
    '/project/src/routes/other/+page.ts',
    '/project/src/routes/[slug]/+page.server.ts',
    '/project/src/routes/[slug]/+layout.svelte',
  ])
    assert.equal(transform('対象外の内容', id), undefined, id);
});
