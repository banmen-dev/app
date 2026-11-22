import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessHeaders } from './dev-open-access.ts';
import { resolveDevOpenTarget } from './dev-open-target.ts';
import { previewBuildEnvironment } from './deploy-preview.ts';

const productionAccount = '71293a3c23974c311b4c82b3f977049b';
const account = 'a'.repeat(32);
const token = 'test-cloudflare-token';
const subdomain = 'banmen-preview-lab';
const buildEnv = {
  WORKERS_CI: '1',
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_PREVIEW_SUBDOMAIN: subdomain,
  VITE_PREVIEW_WITHOUT_ATTACHMENTS: '1',
};

test('Workers Builds のプレビュー専用アカウントとサブドメインだけを受け入れる', () => {
  assert.deepEqual(previewBuildEnvironment(buildEnv), { account, token, subdomain });
});

for (const [label, invalid] of [
  ['Workers Builds 外', { WORKERS_CI: undefined }],
  ['添付 UI の無効化なし', { VITE_PREVIEW_WITHOUT_ATTACHMENTS: undefined }],
  ['CI 値が 1 以外', { WORKERS_CI: 'true' }],
  ['アカウントなし', { CLOUDFLARE_ACCOUNT_ID: undefined }],
  ['アカウント ID が不正', { CLOUDFLARE_ACCOUNT_ID: 'another' }],
  ['本番アカウント', { CLOUDFLARE_ACCOUNT_ID: productionAccount }],
  ['本番アカウントの大文字表記', { CLOUDFLARE_ACCOUNT_ID: productionAccount.toUpperCase() }],
  ['トークンなし', { CLOUDFLARE_API_TOKEN: undefined }],
  ['サブドメインなし', { CLOUDFLARE_PREVIEW_SUBDOMAIN: undefined }],
  ['従来の ucan-lab', { CLOUDFLARE_PREVIEW_SUBDOMAIN: 'ucan-lab' }],
  ['複数ラベル', { CLOUDFLARE_PREVIEW_SUBDOMAIN: 'preview.example' }],
  ['ハイフンで始まる DNS ラベル', { CLOUDFLARE_PREVIEW_SUBDOMAIN: '-preview' }],
  ['ハイフンで終わる DNS ラベル', { CLOUDFLARE_PREVIEW_SUBDOMAIN: 'preview-' }],
  ['DNS ラベルの上限超過', { CLOUDFLARE_PREVIEW_SUBDOMAIN: 'x'.repeat(64) }],
] as const) {
  test(`プレビュー配信環境の ${label} を拒否する`, () => {
    assert.throws(() => previewBuildEnvironment({ ...buildEnv, ...invalid }));
  });
}

const oldOrigin = 'https://pr-374-banmen-preview.ucan-lab.workers.dev';
const newOrigin = `https://pr-374-banmen-preview.${subdomain}.workers.dev`;
const accessEnv = { CF_ACCESS_CLIENT_ID: 'test-client-id', CF_ACCESS_CLIENT_SECRET: 'test-client-secret' };
const isolatedAccessEnv = { ...accessEnv, CLOUDFLARE_PREVIEW_SUBDOMAIN: subdomain };

test('明示したアカウントのプレビューを secure Cookie 用の対象として返す', () => {
  const target = resolveDevOpenTarget(['--origin', newOrigin, 'operator', '/aoba'], isolatedAccessEnv);

  assert.ok(target.ok);
  assert.equal(target.origin, newOrigin);
  assert.equal(target.url, `${newOrigin}/aoba`);
  assert.equal(target.cookieName, '__Host-banmen_session');
  assert.equal(target.who, 'operator');
});

test('サブドメインを明示した場合、旧プレビューやほかのアカウントは Access の対象にしない', () => {
  for (const origin of [oldOrigin, newOrigin.replace(subdomain, 'another-preview'), newOrigin + '.example']) {
    assert.equal(resolveDevOpenTarget(['--origin', origin], isolatedAccessEnv).ok, false, origin);
  }
});

test('サブドメインを明示しなければ旧プレビューだけを許可する', () => {
  assert.equal(resolveDevOpenTarget(['--origin', oldOrigin], accessEnv).ok, true);
  assert.equal(resolveDevOpenTarget(['--origin', newOrigin], accessEnv).ok, false);
});

test('Access のヘッダーは専用サブドメインを明示したプレビューと同一 origin にだけ付ける', () => {
  const target = resolveDevOpenTarget(['--origin', newOrigin], isolatedAccessEnv);
  assert.ok(target.ok);

  assert.deepEqual(accessHeaders(`${newOrigin}/api/me`, target, isolatedAccessEnv), {
    'CF-Access-Client-Id': accessEnv.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': accessEnv.CF_ACCESS_CLIENT_SECRET,
  });
  assert.deepEqual(accessHeaders(`${oldOrigin}/api/me`, target, isolatedAccessEnv), {});
  assert.deepEqual(accessHeaders('https://example.test/api/me', target, isolatedAccessEnv), {});
  assert.deepEqual(accessHeaders(`${newOrigin}/api/me`, target, accessEnv), {});
  assert.deepEqual(accessHeaders(`${newOrigin}/api/me`, target, {}), {});
  assert.deepEqual(
    accessHeaders(`${newOrigin}/api/me`, target, { ...accessEnv, CLOUDFLARE_PREVIEW_SUBDOMAIN: 'another-preview' }),
    {},
  );
});
