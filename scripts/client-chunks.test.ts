import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import viteConfig from '../vite.config.ts';

test('共通部品をまとめても、初期化後に読む版番号と別画面の遅延読み込みを保つ', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'client-chunks-'));
  // SvelteKit の payload → init → app の順序を再現する。LoadFailed の依存までまとめると、
  // start が使う paths と env が同じ束に入り、init 前の空の payload から版が固定されてしまう。
  const modules: Record<string, string> = {
    'fixture:/payload.ts': `export let payload = {};
      export function setPayload(value) { payload = value; }`,
    'fixture:/paths.ts': `import { payload } from 'fixture:/payload.ts';
      export function base() { return payload.base ?? ''; }`,
    'fixture:/env.ts': `import { payload } from 'fixture:/payload.ts';
      export const version = payload.version;`,
    // 仮想モジュールは変換後のJSを返す。実際の基本部品と同じパスで集約の規則に当てる。
    'fixture:/src/lib/components/LoadFailed.svelte': `import { base } from 'fixture:/paths.ts';
      import { version } from 'fixture:/env.ts';
      export function render() { return base() + version; }`,
    'fixture:/app.ts': `export { render } from 'fixture:/src/lib/components/LoadFailed.svelte';`,
    'fixture:/other-page.ts': `export const title = '別画面だけの内容';`,
    'fixture:/start.ts': `import { setPayload } from 'fixture:/payload.ts';
      import { base } from 'fixture:/paths.ts';
      export async function run() {
        setPayload({ base: '/', version: 'v1.2.3' });
        return { base: base(), label: (await import('fixture:/app.ts')).render() };
      }
      export const other = () => import('fixture:/other-page.ts');`,
  };
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const result = (await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [
        {
          name: 'client-chunk-fixture',
          resolveId: (id) => (id in modules ? id : null),
          load: (id) => modules[id],
        },
      ],
      build: {
        outDir: 'dist',
        minify: false,
        modulePreload: false,
        rolldownOptions: {
          ...viteConfig.environments!.client.build!.rolldownOptions,
          input: 'fixture:/start.ts',
          preserveEntrySignatures: 'strict',
        },
      },
    })) as {
      output: {
        type: string;
        fileName: string;
        isEntry?: boolean;
        modules?: Record<string, unknown>;
        imports?: string[];
      }[];
    };
    const chunks = result.output.filter((chunk) => chunk.type === 'chunk');
    const entry = chunks.find((chunk) => chunk.isEntry)!;
    const initial = new Set<string>();
    const visit = (file: string) => {
      if (initial.has(file)) return;
      initial.add(file);
      for (const imported of chunks.find((chunk) => chunk.fileName === file)?.imports ?? []) visit(imported);
    };
    visit(entry.fileName);
    const other = chunks.find((chunk) => 'fixture:/other-page.ts' in (chunk.modules ?? {}))!;
    assert.ok(other, '別画面の束が出ていない');
    assert.equal(initial.has(other.fileName), false, '別画面を最初から読んでいる');
    // eslint-disable-next-line db-entry/guard -- このテストが使い捨てのディレクトリに出した fixture だけを読む。
    const built = await import(pathToFileURL(path.join(dir, 'dist', entry.fileName)).href);
    assert.deepEqual(await built.run(), { base: '/', label: '/v1.2.3' });
    assert.equal((await built.other()).title, '別画面だけの内容');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('検索の補助だけを読む初回の束には、Wikiの検証コードを含めない', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'client-query-chunks-'));
  const root = path.resolve(import.meta.dirname, '..');
  try {
    const entry = path.join(dir, 'entry.ts');
    writeFileSync(
      entry,
      `
      export { searchWordsOf } from ${JSON.stringify(path.join(root, 'src/shared/backlog-filter.ts'))};
      export async function validate(value) {
        const { wikiQuerySchema } = await import(${JSON.stringify(path.join(root, 'src/shared/operations/wiki/index.ts'))});
        return wikiQuerySchema.safeParse(value);
      }
    `,
    );
    const result = (await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: viteConfig.plugins!.filter(
        (plugin) =>
          plugin && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'client-operation-metadata',
      ),
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          ...viteConfig.environments!.client.build!.rolldownOptions,
          input: entry,
          preserveEntrySignatures: 'strict',
        },
      },
    })) as { output: { type: string; fileName: string; isEntry?: boolean; imports?: string[]; code?: string }[] };
    const chunks = result.output.filter((item) => item.type === 'chunk');
    const initial = new Set<string>();
    const visit = (file: string) => {
      if (initial.has(file)) return;
      initial.add(file);
      for (const imported of chunks.find((chunk) => chunk.fileName === file)?.imports ?? []) visit(imported);
    };
    visit(chunks.find((chunk) => chunk.isEntry)!.fileName);
    const code = chunks
      .filter((chunk) => initial.has(chunk.fileName))
      .map((chunk) => chunk.code)
      .join('\n');
    assert.doesNotMatch(code, /["'`]ZodString["'`]/);
    assert.ok(
      chunks.some((chunk) => !initial.has(chunk.fileName)),
      'Wikiの遅延読み込みが分かれていない',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
