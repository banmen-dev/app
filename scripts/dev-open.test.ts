import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('前面化に失敗しても、開いたブラウザを閉じずに人が閉じるまで待つ', () => {
  const entry = new URL('./dev-open.ts', import.meta.url).href;
  const mocks = {
    '@playwright/test': `
      let disconnected;
      export const chromium = { async launch() {
        return {
          on(event, callback) { if (event === 'disconnected') disconnected = callback; },
          async close() { console.log('BROWSER_CLOSED_BY_SCRIPT'); disconnected(); },
          async newContext() { return {
            async addInitScript() {}, async addCookies() {}, on() {},
            async newPage() { return {
              async goto() { console.log('PAGE_LOADED'); },
              async bringToFront() {
                // 人が後からブラウザを閉じるまで、読み込んだページを使える。
                setTimeout(() => { console.log('USER_CLOSED_BROWSER'); disconnected(); }, 30);
                throw new Error('focus unavailable');
              },
              isClosed() { return false; },
            }; },
          }; },
        };
      } };
    `,
    './dev-open-session.ts': 'export async function checkDevOpenSession() { return { ok: true }; }',
  };
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { registerHooks } from 'node:module';
       const entry = ${JSON.stringify(entry)};
       const mocks = ${JSON.stringify(mocks)};
       registerHooks({ resolve(specifier, context, nextResolve) {
         if (context.parentURL === entry && Object.hasOwn(mocks, specifier)) {
           return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
         }
         return nextResolve(specifier, context);
       } });
       await import(entry);`,
    ],
    { encoding: 'utf8', timeout: 10_000, env: { ...process.env, DEV_PORT_OFFSET: '0' } },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGE_LOADED/);
  assert.match(result.stdout, /「手元の確かめ｜[^\n]+」のタブ/);
  assert.match(result.stdout, /USER_CLOSED_BROWSER/);
  assert.doesNotMatch(result.stdout, /BROWSER_CLOSED_BY_SCRIPT/);
  assert.match(result.stderr, /タブを前に出せない/);
});

test('プレビューを開く CLI は Service Worker を止め、Secure Cookie と Access の経路を読み込み前に設定する', () => {
  const entry = new URL('./dev-open.ts', import.meta.url).href;
  const origin = 'https://pr-374-banmen-preview.ucan-lab.workers.dev';
  const playwrightMock = `
    import assert from 'node:assert/strict';
    const origin = ${JSON.stringify(origin)};
    const events = [];
    let disconnected;
    let handler;
    export const chromium = { async launch() {
      return {
        on(event, callback) { if (event === 'disconnected') disconnected = callback; },
        async close() { disconnected(); },
        async newContext(options) {
          assert.deepEqual(options, { viewport: null, serviceWorkers: 'block' });
          events.push('context');
          return {
            async route(pattern, callback) {
              assert.equal(pattern, '**/*');
              handler = callback;
              events.push('access-route');
            },
            async addInitScript() {},
            async addCookies(cookies) {
              assert.equal(cookies.length, 1);
              const cookie = cookies[0];
              assert.equal(cookie.name, '__Host-sg_session');
              assert.equal(cookie.url, origin);
              assert.equal(cookie.secure, true);
              assert.equal(cookie.httpOnly, true);
              assert.equal(typeof cookie.value, 'string');
              assert.ok(cookie.value.length > 0);
              events.push('cookie');
            },
            on() {},
            async newPage() { return {
              async goto(url) {
                assert.equal(url, origin + '/aoba');
                assert.deepEqual(events, ['context', 'access-route', 'cookie']);
                assert.equal(typeof handler, 'function');
                let fulfilled = false;
                const externalUrl = 'https://example.invalid/x';
                const response = { status: () => 302, headers: () => ({ location: externalUrl }) };
                const requestHeaders = {
                  'content-type': 'application/json',
                  origin,
                  accept: 'text/html',
                };
                await handler({
                  request() { return { url() { return url; }, headers() { return requestHeaders; } }; },
                  async fetch(options) {
                    assert.equal(options.maxRedirects, 0);
                    assert.equal(options.headers['CF-Access-Client-Id'], process.env.CF_ACCESS_CLIENT_ID);
                    assert.equal(options.headers['CF-Access-Client-Secret'], process.env.CF_ACCESS_CLIENT_SECRET);
                    for (const [name, value] of Object.entries(requestHeaders)) {
                      assert.equal(options.headers[name], value);
                    }
                    return response;
                  },
                  async fulfill(options) {
                    assert.equal(options.response, response);
                    assert.equal(options.response.status(), 302);
                    assert.equal(options.response.headers().location, externalUrl);
                    fulfilled = true;
                  },
                  async abort() { assert.fail('Access の経路が失敗した'); },
                  async continue() { assert.fail('Access の経路を通っていない'); },
                });
                assert.equal(fulfilled, true);
                // ブラウザが外部の Location を開く段では、Access の秘密を引き継がない。
                let continued = false;
                await handler({
                  request() { return { url() { return externalUrl; }, headers() { return {}; } }; },
                  async fetch() { assert.fail('外部へ Access の付いた fetch をしない'); },
                  async fulfill() { assert.fail('外部の応答は代理で取得しない'); },
                  async abort() { assert.fail('外部のリクエストを止めない'); },
                  async continue(...args) {
                    assert.deepEqual(args, []);
                    continued = true;
                  },
                });
                assert.equal(continued, true);
                console.log('REMOTE_CLI_CONFIGURED');
              },
              async bringToFront() { setTimeout(() => disconnected(), 10); },
              isClosed() { return false; },
            }; },
          };
        },
      };
    } };
  `;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { registerHooks } from 'node:module';
       const entry = ${JSON.stringify(entry)};
       const origin = ${JSON.stringify(origin)};
       const playwrightMock = ${JSON.stringify(playwrightMock)};
       registerHooks({ resolve(specifier, context, nextResolve) {
         if (context.parentURL === entry && specifier === '@playwright/test') {
           return { url: 'data:text/javascript,' + encodeURIComponent(playwrightMock), shortCircuit: true };
         }
         return nextResolve(specifier, context);
       } });
       // 実際の事前確認を通すが、外部通信はしない。
       globalThis.fetch = async (url, init) => {
         assert.equal(url, origin + '/api/me');
         assert.equal(init.redirect, 'manual');
         assert.equal(init.method, 'POST');
         assert.equal(init.headers['CF-Access-Client-Id'], process.env.CF_ACCESS_CLIENT_ID);
         assert.equal(init.headers['CF-Access-Client-Secret'], process.env.CF_ACCESS_CLIENT_SECRET);
         return new Response(null, { status: 200 });
       };
       process.argv = [process.execPath, entry, '--origin', origin, 'admin', '/aoba'];
       await import(entry);`,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        CF_ACCESS_CLIENT_ID: 'cli-test-access-id',
        CF_ACCESS_CLIENT_SECRET: 'cli-test-access-secret',
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REMOTE_CLI_CONFIGURED/);
  assert.match(result.stdout, /admin として https:\/\/pr-374-banmen-preview\.ucan-lab\.workers\.dev\/aoba を開いた/);
  assert.doesNotMatch(result.stdout + result.stderr, /cli-test-access-id|cli-test-access-secret/);
});
