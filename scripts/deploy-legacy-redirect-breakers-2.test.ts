// デプロイのスクリプト（scripts/deploy-legacy-redirect.ts）と、それが出す設定（wrangler.legacy-redirect.jsonc）を崩す手口の2周目。
// scripts/deploy-legacy-redirect.test.ts と scripts/deploy-legacy-redirect-breakers.test.ts と重ならないものだけを置く
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import ts from 'typescript';
import { LEGACY_REDIRECT_TARGET } from '../src/legacy-redirect/worker.ts';
import {
  deployLegacyRedirect,
  LEGACY_ORIGIN,
  VERIFY_INTERVAL_MS,
  VERIFY_MAX_ATTEMPTS,
  type LegacyRedirectDeps,
} from './deploy-legacy-redirect.ts';

const CONFIG = 'wrangler.legacy-redirect.jsonc';

function readJsonc(file: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  assert.equal(parsed.error, undefined, `${file} を読めない`);
  return parsed.config as Record<string, unknown>;
}

describe('崩し: wrangler.legacy-redirect.jsonc の中身', () => {
  const config = readJsonc(CONFIG);

  test('name は旧 URL の workers.dev の名前', () => {
    assert.equal(config.name, 'scrum-guild');
    assert.equal(new URL(LEGACY_ORIGIN).hostname, `${String(config.name)}.ucan-lab.workers.dev`);
  });

  test('main は転送用の Worker で、そのファイルがある', () => {
    assert.equal(config.main, 'src/legacy-redirect/worker.ts');
    assert.ok(existsSync(String(config.main)));
  });

  test('workers_dev で旧 URL に出し、版ごとのプレビュー URL は作らない', () => {
    assert.equal(config.workers_dev, true);
    assert.equal(config.preview_urls, false);
  });

  // docs/operations.md「binding、シークレット、cron を持たない」。本番の D1、R2、vars を旧名の Worker に付けない
  test('binding、vars、cron、資産、経路、env を持たない', () => {
    const forbidden = [
      'vars',
      'd1_databases',
      'r2_buckets',
      'kv_namespaces',
      'durable_objects',
      'services',
      'queues',
      'triggers',
      'assets',
      'routes',
      'route',
      'secrets_store_secrets',
      'ai',
      'vectorize',
      'hyperdrive',
      'analytics_engine_datasets',
      'browser',
      'workflows',
      'dispatch_namespaces',
      'mtls_certificates',
      'send_email',
      'version_metadata',
      'images',
      'tail_consumers',
      'env',
    ];
    assert.deepEqual(
      forbidden.filter((key) => key in config),
      [],
    );
  });

  // docs/requirements.md「テレメトリは送らない」。wrangler.jsonc と .claude/checklists/cloudflare-workers.md は、
  // .claude/settings.json の WRANGLER_SEND_METRICS が Claude のセッションにしか効かず、人の手元ではテレメトリが送られるので、
  // 設定に send_metrics: false を置くとする。この設定は人が手元から wrangler deploy -c で出す
  test('人の手元の wrangler deploy でもテレメトリを送らない（send_metrics: false）', () => {
    assert.equal(config.send_metrics, false);
  });
});

type Reply = { status: number; location: string | null; body: unknown };

const health: Reply = {
  status: 200,
  location: null,
  body: { status: 'ok', database: 'ok', credentialKeys: 'ok', version: 'abc1234' },
};
const noWorker: Reply = { status: 404, location: null, body: null };

function deps(overrides: Partial<LegacyRedirectDeps>, record: { wrangler: string[][]; errors: string[] }) {
  const base: LegacyRedirectDeps = {
    request: async (url) => (url === `${LEGACY_REDIRECT_TARGET}/api/health` ? health : noWorker),
    wrangler: (args) => {
      record.wrangler.push(args);
      return { status: 0 };
    },
    sleep: async () => {},
    now: () => 0,
    log: () => {},
    error: (message) => {
      record.errors.push(message);
    },
  };
  return { ...base, ...overrides };
}

describe('崩し: request が同期で投げる、Error でない値を投げる', () => {
  for (const [name, thrown] of [
    ['Error', new Error('boom')],
    ['文字列', 'boom'],
    ['undefined', undefined],
  ] as const) {
    test(`新しい URL の問い合わせが ${name} を同期で投げても、wrangler を呼ばずに 0 以外で終わる`, async () => {
      const record = { wrangler: [] as string[][], errors: [] as string[] };
      const code = await deployLegacyRedirect(
        deps(
          {
            request: () => {
              throw thrown;
            },
          },
          record,
        ),
      );
      assert.notEqual(code, 0);
      assert.deepEqual(record.wrangler, []);
      assert.ok(record.errors.length > 0);
    });
  }
});

describe('崩し: 置いた後の確かめで時計が止まる', () => {
  // Issue #1421「時間と回数の上限つき」。now が進まなくても、回数の上限で終わる
  test('now がずっと同じ値でも、回数の上限で 0 以外で終わり、wrangler を1回だけ呼ぶ', async () => {
    const record = { wrangler: [] as string[][], errors: [] as string[] };
    let checks = 0;
    let slept = 0;
    let deployed = false;
    const code = await deployLegacyRedirect(
      deps(
        {
          request: async (url) => {
            if (url === `${LEGACY_REDIRECT_TARGET}/api/health`) return health;
            if (deployed && url === `${LEGACY_ORIGIN}/`) {
              checks++;
              if (checks > 1000) throw new Error('回数の上限を見ていない');
            }
            return noWorker;
          },
          wrangler: (args) => {
            record.wrangler.push(args);
            deployed = true;
            return { status: 0 };
          },
          sleep: async (ms) => {
            assert.ok(ms > 0 && ms <= VERIFY_INTERVAL_MS, `sleep の時間が ${ms}`);
            slept++;
          },
        },
        record,
      ),
    );
    assert.notEqual(code, 0);
    assert.equal(record.wrangler.length, 1);
    assert.ok(checks <= VERIFY_MAX_ATTEMPTS, `${checks} 回確かめた`);
    assert.ok(checks > 1, '確かめ直していない');
    assert.equal(slept, checks - 1);
  });
});

describe('崩し: wrangler に渡す設定', () => {
  test('-c に渡す設定のファイルが、リポジトリの直下から見つかる', async () => {
    const record = { wrangler: [] as string[][], errors: [] as string[] };
    await deployLegacyRedirect(deps({}, record));
    assert.equal(record.wrangler.length, 1);
    const args = record.wrangler[0]!;
    const file = args[args.indexOf('-c') + 1]!;
    assert.ok(existsSync(file), `${file} が無い`);
    assert.equal(readJsonc(file).main, 'src/legacy-redirect/worker.ts');
  });
});
