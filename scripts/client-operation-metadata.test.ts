import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';
import ts from 'typescript';
import { parse as parseSvelte } from 'svelte/compiler';
import viteConfig from '../vite.config.ts';
import { clientOperationMetadata, clientOutputOperationNames } from './client-operation-metadata.ts';
import { organizationInfo } from '../src/shared/operations/organization/organization.ts';
import { meAvatarUpload } from '../src/shared/operations/organization/me-avatar.ts';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { connectionScopeCandidates } from '../src/shared/operations/connection/connection-scope-candidates.ts';
import { operationPath } from '../src/shared/operations/define.ts';

const root = path.resolve(import.meta.dirname, '..');

test('スキーマを省くのは client 環境だけ（Worker・SSR に適用しない）', () => {
  const applies = clientOperationMetadata().applyToEnvironment as (environment: { name: string }) => boolean;
  assert.equal(applies({ name: 'client' }), true);
  for (const name of ['ssr', 'worker', 'server']) assert.equal(applies({ name }), false);
  assert.equal(organizationInfo.input.safeParse({ include_storage: true }).success, true);
  assert.equal(organizationInfo.input.safeParse({ include_storage: 'yes' }).success, false);
  assert.equal(meAvatarUpload.output.safeParse({ avatar_url: 42 }).success, false);
});

test('実際のブラウザの束でも URL・待ち上限・アップロード応答の検証を保つ', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sg-client-operations-'));
  try {
    const entry = path.join(dir, 'entry.ts');
    writeFileSync(
      entry,
      [
        `export { organizationInfo } from ${JSON.stringify(path.join(root, 'src/shared/operations/organization/organization.ts'))};`,
        `export { meAvatarUpload } from ${JSON.stringify(path.join(root, 'src/shared/operations/organization/me-avatar.ts'))};`,
        `export { attachmentUpload } from ${JSON.stringify(path.join(root, 'src/shared/operations/attachment/index.ts'))};`,
        `export { connectionScopeCandidates } from ${JSON.stringify(path.join(root, 'src/shared/operations/connection/connection-scope-candidates.ts'))};`,
        `export { operationPath } from ${JSON.stringify(path.join(root, 'src/shared/operations/define.ts'))};`,
      ].join('\n'),
    );
    const result = (await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: viteConfig.plugins!.filter(
        (plugin) =>
          plugin && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'client-operation-metadata',
      ),
      build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
    })) as { output: { type: string; code?: string }[] }[];
    const chunks = result.flatMap((result) => result.output).filter((chunk) => chunk.type === 'chunk');
    assert.equal(chunks.length, 1);
    // eslint-disable-next-line db-entry/guard -- このテストでリポジトリの定義だけから束ねた固定の fixture を読む。
    const client = await import(`data:text/javascript;base64,${Buffer.from(chunks[0].code!).toString('base64')}`);
    for (const [name, definition] of Object.entries({
      organizationInfo,
      meAvatarUpload,
      attachmentUpload,
      connectionScopeCandidates,
    })) {
      const browser = client[name];
      assert.equal(client.operationPath(browser, 'aoba'), operationPath(definition, 'aoba'));
      assert.equal(browser.mode, definition.mode);
      assert.equal(browser.clientTimeoutMs, 'clientTimeoutMs' in definition ? definition.clientTimeoutMs : undefined);
      assert.equal('input' in browser, false);
      assert.equal('description' in browser, false);
      if (!clientOutputOperationNames.has(definition.name)) assert.equal('output' in browser, false);
    }
    for (const value of [null, {}, { avatar_url: 42 }, { avatar_url: '/avatar' }]) {
      assert.equal(
        client.meAvatarUpload.output.safeParse(value).success,
        meAvatarUpload.output.safeParse(value).success,
      );
    }
    const uploaded = {
      id: 'file',
      file_name: 'a.png',
      content_type: 'image/png',
      size_bytes: 10,
      created_at: '2026-11-17T00:00:00Z',
    };
    assert.equal(client.attachmentUpload.output.safeParse(uploaded).success, true);
    for (const value of [null, {}, { id: 42 }, uploaded]) {
      assert.equal(
        client.attachmentUpload.output.safeParse(value).success,
        attachmentUpload.output.safeParse(value).success,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function componentCode(code: string): string {
  const scripts = [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const expressions: string[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    const expression = node.expression as { start?: number; end?: number } | undefined;
    if (typeof expression?.start === 'number' && typeof expression.end === 'number') {
      expressions.push(`void (${code.slice(expression.start, expression.end)});`);
    }
    Object.values(node).forEach(visit);
  }
  visit(parseSvelte(code, { modern: true }).fragment);
  return [...scripts, ...expressions].join('\n');
}

function schemaViolations(sources: Record<string, string>): string[] {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (file) => sources[file] ?? read(file);
  host.fileExists = (file) => file in sources || exists(file);
  host.getSourceFile = (file, languageVersion) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
  };
  const program = ts.createProgram(Object.keys(sources), options, host);
  const checker = program.getTypeChecker();
  const failures: string[] = [];
  function inspect(node: ts.Node, key: string, file: string) {
    let type = checker.getTypeAtLocation(node);
    type = checker.getBaseConstraintOfType(type) ?? type;
    if (!['name', 'permission', 'mode', 'input', 'output'].every((key) => checker.getPropertyOfType(type, key))) return;
    const name = checker.getTypeOfSymbolAtLocation(checker.getPropertyOfType(type, 'name')!, node);
    const names = name.isUnion() ? name.types : [name];
    if (key === 'output' && names.every((name) => name.isStringLiteral() && clientOutputOperationNames.has(name.value)))
      return;
    failures.push(`${path.relative(root, file)}: ${key}`);
  }
  for (const file of Object.keys(sources)) {
    const source = program.getSourceFile(file)!;
    function visit(node: ts.Node) {
      if (ts.isPropertyAccessExpression(node) && ['input', 'output'].includes(node.name.text))
        inspect(node.expression, node.name.text, file);
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        ['input', 'output'].includes(node.argumentExpression.text)
      )
        inspect(node.expression, node.argumentExpression.text, file);
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isObjectBindingPattern(node.name)) {
        for (const binding of node.name.elements) {
          const key = (binding.propertyName ?? binding.name).getText(source).replaceAll(/["']/g, '');
          if (['input', 'output'].includes(key))
            inspect(ts.isVariableDeclaration(node) && node.initializer ? node.initializer : node.name, key, file);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return failures;
}

test('別名・namespace・分割代入・引数・角括弧のスキーマ参照を検出する', () => {
  const file = path.join(root, 'src/extra-client.ts');
  const source = `
    import { organizationInfo as renamed } from './shared/operations/organization/organization.ts';
    import * as definitions from './shared/operations/organization/organization.ts';
    import type { AnyOperationDefinition } from './shared/operations/define.ts';
    const a = renamed.input;
    const b = definitions.organizationInfo.output;
    const { output: c } = renamed;
    function take(op: AnyOperationDefinition) { return op.output; }
    const d = renamed['output'];
  `;
  assert.equal(schemaViolations({ [file]: source }).length, 5);
  const component = componentCode(
    `<script lang="ts">import { organizationInfo as renamed } from './shared/operations/organization/organization.ts';</script><p>{renamed.output}</p>`,
  );
  assert.equal(schemaViolations({ [file]: component }).length, 1);
});

test('全クライアントのスキーマ参照は、保持する操作の output だけ', () => {
  const sources: Record<string, string> = {};
  for (const entry of readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|svelte)$/.test(entry.name) || /\.test\.|\.typecheck\./.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (/(^|[/\\])(server|shared)[/\\]/.test(path.relative(path.join(root, 'src'), file))) continue;
    const code = readFileSync(file, 'utf8');
    sources[file.endsWith('.svelte') ? `${file}.ts` : file] = file.endsWith('.svelte') ? componentCode(code) : code;
  }
  assert.deepEqual(schemaViolations(sources), []);
});
