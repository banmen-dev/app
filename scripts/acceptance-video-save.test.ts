import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// 本体や D1 を使わず、blur の保存と遷移の順を小さな HTTP サーバーで再現する。
test(
  '試しは Tab 保存の応答本文と複数の書き込みを待ち、読み込みは待たない',
  {
    skip: !existsSync(chromium.executablePath()) && 'Playwright の chromium が無い',
  },
  () => {
    const probeUrl = JSON.stringify(new URL('../.claude/skills/acceptance-video/probe.mjs', import.meta.url).href);
    const planUrl = JSON.stringify(new URL('../.claude/skills/acceptance-video/plan.mjs', import.meta.url).href);
    const code = String.raw`
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { probeExec } from ${probeUrl};
import { probePlan, runProbe, formatProbeLine } from ${planUrl};
const { chromium } = createRequire(process.cwd() + '/package.json')('@playwright/test');
let saved = '';
let completed = 0;
const server = createServer((req, res) => {
  if (req.url === '/slow-get' || req.url === '/stuck') return;
  if (req.url === '/failed') { req.socket.destroy(); return; }
  if (req.method === 'POST' || req.method === 'PATCH') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('saving'); // ヘッダーだけでは完了にしない
    setTimeout(() => { saved = '保存した行'; completed++; res.end('done'); }, req.url === '/save' ? 150 : 300);
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(req.url === '/result' ? '<p id="result">' + saved + '</p>' :
    '<input id="edit" onblur="fetch(\'/save\', {method:\'POST\'}); fetch(\'/second\', {method:\'PATCH\'}); fetch(\'/slow-get\')"><button>次へ</button>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const exec = probeExec(page, base);
  const results = await runProbe(probePlan({ steps: [
    { actions: [{goto: '/'}, {fill: {css: '#edit'}, text: '保存した行'}, {press: 'Tab'}] },
    { actions: [{goto: '/result'}], markAfter: {css: '#result'} },
  ] }), exec);
  assert.ok(results.every(r => r.status === 'found'), JSON.stringify(results));
  assert.equal(completed, 2);
  assert.equal(await page.locator('#result').textContent(), '保存した行');
  // 通信の失敗で要求が残り続けない。
  await page.evaluate(() => { fetch('/failed', {method: 'DELETE'}).catch(() => {}); });
  await exec({kind: 'goto', path: '/'});
  // 応答しない書き込みはタイムアウトし、遷移を実行しない。
  await page.evaluate(() => { fetch('/stuck', {method: 'PUT'}); });
  let timeoutError;
  await assert.rejects(exec({kind: 'goto', path: '/result'}), error => {
    timeoutError = error;
    return /保存の要求が完了しない/.test(error.message);
  });
  const stopped = await runProbe([
    {step: 1, kind: 'goto', path: '/result'},
    {step: 1, kind: 'markAfter', spec: {css: '#result'}},
  ], async () => { throw timeoutError; });
  assert.match(formatProbeLine(stopped[0]), /保存待ちで中止: goto/);
  assert.equal(stopped[1].status, 'skipped');
  assert.match(stopped[1].reason, /保存待ちで中止/);
  assert.doesNotMatch(stopped[1].reason, /見つからず/);
  assert.equal(page.url(), base + '/');
  console.log('保存・失敗・タイムアウト・読み込み除外を確認');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /保存・失敗・タイムアウト・読み込み除外を確認/);
  },
);

test('試しは直前の操作が全体遷移を始めていても、読み込み後に保存待ちをやり直す', () => {
  const probeUrl = JSON.stringify(new URL('../.claude/skills/acceptance-video/probe.mjs', import.meta.url).href);
  const code = `
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probeExec } from ${probeUrl};
const page = new EventEmitter();
const calls = [];
let first = true;
page.evaluate = async () => {
  calls.push('evaluate');
  if (first) { first = false; throw new Error('Execution context was destroyed, most likely because of a navigation'); }
};
page.waitForLoadState = async (state, options) => {
  assert.equal(state, 'domcontentloaded');
  assert.ok(options.timeout > 0 && options.timeout <= 5000);
  calls.push('loaded');
};
page.goto = async () => { calls.push('goto'); return {status: () => 200}; };
await probeExec(page, 'http://localhost')({kind: 'goto', path: '/next'});
assert.deepEqual(calls, ['evaluate', 'loaded', 'evaluate', 'goto']);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
