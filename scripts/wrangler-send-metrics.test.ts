// リポジトリのルートの wrangler*.jsonc がどれもテレメトリを送らないことを確かめる。
// docs/requirements.md「テレメトリは送らない」と .claude/checklists/cloudflare-workers.md の「設定と秘密」は、
// .claude/settings.json の WRANGLER_SEND_METRICS が Claude のセッションにしか効かず、人の手元と Workers Builds では
// テレメトリが送られるので、設定に send_metrics: false を置くとする。設定を足したときの置き忘れもここで落とす
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import ts from 'typescript';

const ROOT = new URL('..', import.meta.url);

const configs = readdirSync(ROOT)
  .filter((name) => /^wrangler.*\.jsonc$/.test(name))
  .sort();

function readJsonc(name: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(name, readFileSync(new URL(name, ROOT), 'utf8'));
  assert.equal(parsed.error, undefined, `${name} を読めない`);
  return parsed.config as Record<string, unknown>;
}

describe('ルートの wrangler*.jsonc のテレメトリ', () => {
  test('設定が見つかる（列挙の誤りで何も確かめずに通らない）', () => {
    assert.ok(configs.includes('wrangler.jsonc'), `wrangler.jsonc が列挙に無い: ${configs.join(', ')}`);
  });

  for (const name of configs) {
    test(`${name} は send_metrics: false を置く`, () => {
      assert.equal(readJsonc(name).send_metrics, false);
    });
  }
});
