// wrangler.jsonc の triggers.crons が、定期処理の表（src/server/scheduled/index.ts）の式と食い違わないことを確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const root = import.meta.dirname + '/..';

describe('wrangler.jsonc の triggers.crons', () => {
  test('固定の式と取り込み用の変数の式を登録する', () => {
    const text = readFileSync(`${root}/wrangler.jsonc`, 'utf8');
    const match = /"crons"\s*:\s*(\[[^\]]*\])/.exec(text);
    const importCron = /"IMPORT_SYNC_CRON"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    assert.ok(match, 'triggers.crons が見つからない');
    assert.ok(importCron, 'vars.IMPORT_SYNC_CRON が見つからない');
    const expected = [...new Set(['* * * * *', '0 * * * *', importCron])];
    assert.deepEqual((JSON.parse(match[1]!) as string[]).sort(), expected.sort());
  });

  test('固定の式が定期処理の表にある', () => {
    const text = readFileSync(`${root}/src/server/scheduled/index.ts`, 'utf8');
    for (const cron of ['* * * * *', '0 * * * *']) {
      assert.ok(text.includes(`['${cron}',`), `定期処理の表に無い式: ${cron}`);
    }
  });
});
