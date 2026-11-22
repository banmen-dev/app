import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Route } from '@playwright/test';
import { accessHeaders, installDevOpenAccess } from './dev-open-access.ts';
import { resolveDevOpenTarget } from './dev-open-target.ts';

const origin = 'https://pr-374-banmen-preview.ucan-lab.workers.dev';
const env = { CF_ACCESS_CLIENT_ID: 'test-id', CF_ACCESS_CLIENT_SECRET: 'test-secret' };
const target = resolveDevOpenTarget(['--origin', origin], env);
assert.ok(target.ok);

test('Access は同じプレビューだけに送り、他のプレビュー・本番・外部には送らない', () => {
  assert.deepEqual(accessHeaders(`${origin}/api/me`, target, env), {
    'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
  });
  for (const url of [
    'https://banmen.ucan-lab.workers.dev/',
    'https://pr-375-banmen-preview.ucan-lab.workers.dev/',
    `${origin}.evil.example/`,
    'https://example.com/',
    'http://localhost:5173/',
  ])
    assert.deepEqual(accessHeaders(url, target, env), {}, url);
  assert.throws(() => accessHeaders(origin, target, {}), /両方が必要/);
});

test('ブラウザはリダイレクトを追わずに返し、外部のリクエストには秘密を付けない', async () => {
  let handler: Parameters<BrowserContext['route']>[1] | undefined;
  const context: Pick<BrowserContext, 'route'> = {
    route: async (_pattern, callback) => {
      handler = callback;
      return { async dispose() {}, async [Symbol.asyncDispose]() {} };
    },
  };
  await installDevOpenAccess(context, target, env);
  assert.ok(handler);
  const calls: unknown[] = [];
  const response = {};
  const route = (url: string) =>
    ({
      request: () => ({ url: () => url, headers: () => ({ accept: 'text/html' }) }),
      fetch: async (options: unknown) => {
        calls.push(options);
        return response;
      },
      fulfill: async (options: unknown) => {
        calls.push(options);
      },
      continue: async (...args: unknown[]) => {
        calls.push(args);
      },
    }) as unknown as Route;
  const ownRoute = route(`${origin}/`);
  await handler(ownRoute, ownRoute.request());
  assert.deepEqual(calls, [
    { headers: { accept: 'text/html', ...accessHeaders(origin, target, env) }, maxRedirects: 0 },
    { response },
  ]);
  calls.length = 0;
  const externalRoute = route('https://example.com/redirected');
  await handler(externalRoute, externalRoute.request());
  assert.deepEqual(calls, [[]]);
});
