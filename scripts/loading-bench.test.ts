import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./loading-bench.ts', import.meta.url));

for (const { options, error, name } of [
  { options: ['--unknown-option'], error: /ERR_PARSE_ARGS_UNKNOWN_OPTION/, name: '未知のオプションを拒む' },
  { options: ['--runs', '0', '--runs', '1'], error: /--runs が範囲外です/, name: '最初の回数指定を検査する' },
  { options: ['--port', '0', '--port', '9742'], error: /--port が範囲外です/, name: '最初のポート指定を検査する' },
]) {
  test(`画面の読み込み計測は一時 D1 の作成前に${name}`, (context) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'banmen-loading-cli-test-'));
    context.after(() => rmSync(dir, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [script, ...options], {
      env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, PATH: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, '');
    assert.deepEqual(readdirSync(dir), []);
  });
}
