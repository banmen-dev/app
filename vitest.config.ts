// scripts/ のテストは node --test で動かす（pnpm test）。
// - workers: API のテストを Workers の実行環境で動かす（test/）。テストの D1 には、test/apply-migrations.ts が全マイグレーションを当てる。読むのは Node の側でしかできないので、ここで読んで binding で渡す
// - preview-trigger: プレビュー起動 Worker の Durable Object を別の構成で動かす
// - legacy-redirect: 旧 URL の転送用の Worker を、その設定（wrangler.legacy-redirect.jsonc）の Workers の実行環境で動かす（test/legacy-redirect*.test.ts）
// - web: 画面のコードのテストを node の環境で動かす（src/ の *.test.ts）。Workers の実行環境では .svelte を描けないため、svelte/server の render で HTML にして確かめる
// - web-client: 部品の配線（`*.svelte.ts` の $effect）を、DOM なしのブラウザ向けの実行で確かめる（src/ の *.svelte.test.ts）
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { previewTriggerOutbound, testBindings } from './test/preview-trigger-outbound.ts';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  const previewConcurrencyTest = 'test/preview-trigger-concurrency.test.ts';
  const legacyRedirectTest = 'test/legacy-redirect*.test.ts';
  const outbound = { node: previewTriggerOutbound() };
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  // 接続の認証情報の暗号鍵。テスト用の架空の値で、本番の鍵ではない
                  CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': 'dGVzdC1rZXktZm9yLXVuaXQtdGVzdHMtb25seS0hISE=' }),
                },
              },
            }),
          ],
          test: {
            name: 'workers',
            include: ['test/**/*.test.ts'],
            exclude: [previewConcurrencyTest, legacyRedirectTest],
            setupFiles: ['./test/apply-migrations.ts'],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.preview-trigger.jsonc' },
              miniflare: {
                bindings: testBindings,
                outboundService: outbound,
                serviceBindings: { PREVIEW_FIXTURE: outbound },
              },
            }),
          ],
          test: { name: 'preview-trigger', include: [previewConcurrencyTest] },
        },
        {
          plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.legacy-redirect.jsonc' } })],
          test: { name: 'legacy-redirect', include: [legacyRedirectTest] },
        },
        {
          plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })],
          test: {
            name: 'web',
            environment: 'node',
            include: ['src/**/*.test.ts'],
            exclude: ['src/**/*.svelte.test.ts'],
          },
        },
        {
          plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })],
          // ブラウザ向けの Svelte の実行（$effect.root と flushSync）で、DOM なしに、部品の配線を確かめる
          resolve: { conditions: ['browser'] },
          test: {
            name: 'web-client',
            environment: './scripts/vitest-client-environment.ts',
            include: ['src/**/*.svelte.test.ts'],
          },
        },
      ],
    },
  };
});
