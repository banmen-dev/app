import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';
import { clientOperationMetadata } from './client-operation-metadata.ts';
import { organizationInfo } from '../src/shared/operations/organization/organization.ts';
import { meAvatarUpload } from '../src/shared/operations/organization/me-avatar.ts';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { connectionScopeCandidates } from '../src/shared/operations/connection/connection-scope-candidates.ts';
import { operationPath } from '../src/shared/operations/define.ts';

const root = path.resolve(import.meta.dirname, '..');
const outputSchemas = new Set(['meAvatarUpload', 'attachmentUpload']);

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
      plugins: [clientOperationMetadata()],
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
      if (!outputSchemas.has(name)) assert.equal('output' in browser, false);
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

test('画面がスキーマを読む操作を増やしたら、ブラウザへの出力方針も更新する', () => {
  for (const base of ['src/lib', 'src/routes']) {
    for (const entry of readdirSync(path.join(root, base), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|svelte)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      const code = readFileSync(file, 'utf8');
      const imported = [
        ...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*shared\/operations\/[^'"]+['"]/g),
      ].flatMap((match) => match[1].split(',').map((name) => name.trim()));
      for (const [, name, property] of code.matchAll(/\b(\w+)\.(input|output)\b/g)) {
        if (!imported.includes(name)) continue;
        assert.ok(
          property === 'output' && outputSchemas.has(name),
          `${file}: ${name}.${property} をブラウザで使っている`,
        );
      }
    }
  }
});
