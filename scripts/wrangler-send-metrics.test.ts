// リポジトリのルートの wrangler*.jsonc がどれもテレメトリを送らないことを確かめる。
// docs/requirements.md「テレメトリは送らない」と .claude/checklists/cloudflare-workers.md の「設定と秘密」は、
// .claude/settings.json の WRANGLER_SEND_METRICS が Claude のセッションにしか効かず、人の手元と Workers Builds では
// テレメトリが送られるので、設定に send_metrics: false を置くとする。設定を足したときの置き忘れもここで落とす
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import ts from 'typescript';

const ROOT = new URL('..', import.meta.url);

// wrangler は wrangler.json と wrangler.toml も読む（.github/labeler.yml も wrangler の設定として扱う）ので列挙に含め、
// JSONC として読めない .toml は readJsonc で落とす。設定はルートだけに置く
const configs = readdirSync(ROOT)
  .filter((name) => /^wrangler.*\.(jsonc?|toml)$/i.test(name))
  .sort();

function readJsonc(name: string): Record<string, unknown> {
  assert.ok(
    !/\.toml$/i.test(name),
    `${name}: 設定は JSONC で置く（.toml は send_metrics をこのテストで確かめられない）`,
  );
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
      const value = readJsonc(name).send_metrics;
      assert.equal(value, false, `${name}: send_metrics は ${JSON.stringify(value)}`);
    });
  }
});
