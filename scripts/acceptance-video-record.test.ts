import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

test(
  '録画は操作で現れる結果に markAfter を付け、hold 後に外す（操作なしも可）',
  {
    skip: !existsSync(chromium.executablePath()) && 'Playwright の chromium が無い',
  },
  async () => {
    const marks: string[] = [];
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/mark?')) {
        marks.push(new URL(req.url, 'http://localhost').searchParams.get('value') ?? '');
        res.end('ok');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(`<button id="before" onclick="this.insertAdjacentHTML('afterend', '<p id=result>Saved</p>')">Save</button>
<script>
new MutationObserver(records => {
  for (const {target} of records) {
    if (!target.id) continue;
    fetch('/mark?value=' + encodeURIComponent(target.id + ':' + Boolean(target.style.outline)));
  }
}).observe(document.body, {attributes: true, attributeFilter: ['style'], subtree: true});
</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-record-'));
    try {
      // record.mjs の入口を使い、本体・D1・認証情報を使わない録画用の小さな作業ルートを作る。
      for (const path of ['scripts', 'seed', 'src/shared']) mkdirSync(join(dir, path), { recursive: true });
      symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'));
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'scripts/dev-ports.ts'), `export const devPorts = () => ({api: ${address.port}});`);
      writeFileSync(join(dir, 'seed/sessions.ts'), "export const SEED_SESSIONS = {admin: {token: 'fixture-only'}};");
      writeFileSync(join(dir, 'src/shared/session-cookie.ts'), "export const sessionCookieName = () => 'fixture';");
      writeFileSync(
        join(dir, 'steps.json'),
        JSON.stringify({
          steps: [
            { actions: [{ goto: '/' }], hold: 0 },
            {
              mark: { css: '#before' },
              actions: [{ click: { css: '#before' } }],
              markAfter: { css: '#result' },
              hold: 200,
            },
            { markAfter: { css: '#result' }, hold: 200 },
          ],
        }),
      );
      const script = fileURLToPath(new URL('../.claude/skills/acceptance-video/record.mjs', import.meta.url));
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [script, 'steps.json', 'video'], { cwd: dir, timeout: 20_000 });
        let output = '';
        child.stdout.on('data', (data) => {
          output += data;
        });
        child.stderr.on('data', (data) => {
          output += data;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      });
      assert.equal(result.code, 0, result.output);
      // outlineOffset の通知との重複を除く。markAfter を消す・前へ動かす・外さない変更で失敗する。
      assert.deepEqual(
        marks.filter((value, i) => value !== marks[i - 1]),
        ['before:true', 'before:false', 'result:true', 'result:false', 'result:true', 'result:false'],
      );
      assert.ok(readFileSync(join(dir, 'video/recording.webm')).length > 0);
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, 'video/cues.json'), 'utf8')).map((cue: { text: string }) => cue.text),
        [''],
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
