import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { isPreviewOrigin, parseDevOpenArgs, resolveDevOpenTarget } from './dev-open-target.ts';

// ワークツリーの名前から導いたオフセットに依らず、既定のポート（5173、8787）を見る
const DEFAULT_ENV = { DEV_PORT_OFFSET: '0' };

function failureReason(result: { ok: boolean; reason?: string }): string {
  assert.equal(result.ok, false);
  return result.reason ?? '';
}

describe('parseDevOpenArgs', () => {
  test('省略したときは admin と /', () => {
    assert.deepEqual(parseDevOpenArgs([]), { ok: true, preview: false, who: 'admin', path: '/' });
  });

  test('位置でなく形で見分ける（--preview、/ で始まる path、それ以外は who）', () => {
    const expected = { ok: true, preview: true, who: 'member', path: '/aoba' };
    assert.deepEqual(parseDevOpenArgs(['member', '/aoba', '--preview']), expected);
    assert.deepEqual(parseDevOpenArgs(['--preview', '/aoba', 'member']), expected);
    assert.deepEqual(parseDevOpenArgs(['/aoba', 'member', '--preview']), expected);
    assert.deepEqual(parseDevOpenArgs(['/aoba']), { ok: true, preview: false, who: 'admin', path: '/aoba' });
    assert.deepEqual(parseDevOpenArgs(['operator']), { ok: true, preview: false, who: 'operator', path: '/' });
  });

  test('同じ種類が2つ以上あれば理由を出して止める', () => {
    assert.match(failureReason(parseDevOpenArgs(['admin', 'member'])), /who が2つ/);
    assert.match(failureReason(parseDevOpenArgs(['/a', '/b'])), /path が2つ/);
  });

  test('--preview 以外の -- で始まるフラグは止める', () => {
    for (const flag of ['--help', '--previews', '--', '--preview=1']) {
      assert.match(failureReason(parseDevOpenArgs([flag])), /知らないフラグ/, flag);
    }
  });

  test('知らない who は、選べるキーと description を並べて止める', () => {
    const reason = failureReason(parseDevOpenArgs(['nobody']));
    assert.match(reason, /nobody/);
    for (const [key, session] of Object.entries(SEED_SESSIONS)) {
      assert.ok(reason.includes(`${key}: ${session.description}`), key);
    }
    // Object のプロパティ名も who にしない
    assert.match(failureReason(parseDevOpenArgs(['toString'])), /知らない who/);
    assert.match(failureReason(parseDevOpenArgs(['__proto__'])), /知らない who/);
  });
});

describe('resolveDevOpenTarget', () => {
  test('pnpm dev の画面の origin、Cookie の名前、seed のトークンで URL を組む', () => {
    assert.deepEqual(resolveDevOpenTarget(['admin', '/aoba'], DEFAULT_ENV), {
      ok: true,
      preview: false,
      who: 'admin',
      path: '/aoba',
      origin: 'http://localhost:5173',
      url: 'http://localhost:5173/aoba',
      cookieName: 'banmen_session',
      token: SEED_SESSIONS.admin.token,
    });
  });

  test('--preview は wrangler dev の origin', () => {
    const target = resolveDevOpenTarget(['--preview', 'operator'], DEFAULT_ENV);
    assert.ok(target.ok);
    assert.equal(target.origin, 'http://localhost:8787');
    assert.equal(target.url, 'http://localhost:8787/');
    assert.equal(target.token, SEED_SESSIONS.operator.token);
  });

  test('DEV_PORT_OFFSET で origin がずれる', () => {
    const dev = resolveDevOpenTarget(['/aoba'], { DEV_PORT_OFFSET: '10' });
    assert.ok(dev.ok);
    assert.equal(dev.url, 'http://localhost:5183/aoba');
    const preview = resolveDevOpenTarget(['--preview'], { DEV_PORT_OFFSET: '10' });
    assert.ok(preview.ok);
    assert.equal(preview.origin, 'http://localhost:8797');
  });

  test('DEV_PORT_OFFSET が不正なら止める', () => {
    assert.match(failureReason(resolveDevOpenTarget([], { DEV_PORT_OFFSET: 'x' })), /DEV_PORT_OFFSET/);
  });

  test('受け付けない path は、/ に直さず理由を出して止める', () => {
    for (const path of ['//evil.example', '/\\evil.example', '/.//evil.example', '/api/me', '/login']) {
      assert.match(failureReason(resolveDevOpenTarget(['admin', path], DEFAULT_ENV)), /開けない/, path);
    }
    // `/` で始まらない値（相対パス、完全な URL）は path でなく who と読まれ、知らない who で止まる
    for (const value of ['aoba', 'http://localhost:5173/x']) {
      assert.match(failureReason(resolveDevOpenTarget([value], DEFAULT_ENV)), /知らない who/, value);
    }
  });

  test('URL の解決で別の形になる path は止める', () => {
    // 空白は safeReturnTo を通るが、URL の解決で %20 になる
    assert.match(failureReason(resolveDevOpenTarget(['/a b'], DEFAULT_ENV)), /別のパスになる/);
  });

  test('path は、クエリとフラグメントを含めてそのまま使う', () => {
    const target = resolveDevOpenTarget(['/aoba/board?tab=1#top'], DEFAULT_ENV);
    assert.ok(target.ok);
    assert.equal(target.url, 'http://localhost:5173/aoba/board?tab=1#top');
  });

  test('引数で止まるときは origin を決めない（不正な DEV_PORT_OFFSET より引数の理由が先）', () => {
    assert.match(failureReason(resolveDevOpenTarget(['nobody'], { DEV_PORT_OFFSET: 'x' })), /知らない who/);
  });
});

const PREVIEW_ORIGIN = 'https://pr-374-banmen-preview.ucan-lab.workers.dev';
const ACCESS_ENV = { CF_ACCESS_CLIENT_ID: 'test-id', CF_ACCESS_CLIENT_SECRET: 'test-secret' };

test('プレビューは全 seed ロールを secure Cookie の名前で開く。ローカルポート設定は使わない', () => {
  for (const [who, session] of Object.entries(SEED_SESSIONS)) {
    const result = resolveDevOpenTarget(['--origin', PREVIEW_ORIGIN, who, '/aoba'], {
      ...ACCESS_ENV,
      DEV_PORT_OFFSET: 'x',
    });
    assert.ok(result.ok);
    assert.equal(result.origin, PREVIEW_ORIGIN);
    assert.equal(result.cookieName, '__Host-banmen_session');
    assert.equal(result.token, session.token);
    assert.equal(result.url, `${PREVIEW_ORIGIN}/aoba`);
  }
});

test('プレビュー以外の origin と origin の曖昧な指定を断る', () => {
  for (const origin of [
    'https://scrum-guild.ucan-lab.workers.dev',
    'https://pr-374-scrum-guild-preview.ucan-lab.workers.dev',
    'http://pr-374-banmen-preview.ucan-lab.workers.dev',
    `${PREVIEW_ORIGIN}\n`,
    `${PREVIEW_ORIGIN}/`,
    `${PREVIEW_ORIGIN}/aoba`,
    `${PREVIEW_ORIGIN}?x`,
    `${PREVIEW_ORIGIN}#x`,
    `${PREVIEW_ORIGIN}:443`,
    `${PREVIEW_ORIGIN}.evil.example`,
    PREVIEW_ORIGIN.toUpperCase(),
    PREVIEW_ORIGIN.replace('https://', 'https://user:secret@'),
    PREVIEW_ORIGIN.replace('pr-374', 'pr-0'),
    PREVIEW_ORIGIN.replace('pr-374', 'pr-0374'),
  ])
    assert.equal(resolveDevOpenTarget(['--origin', origin], ACCESS_ENV).ok, false, origin);
  assert.equal(parseDevOpenArgs(['--origin']).ok, false);
  assert.equal(parseDevOpenArgs(['--origin', PREVIEW_ORIGIN, '--origin', PREVIEW_ORIGIN]).ok, false);
  assert.equal(parseDevOpenArgs(['--preview', '--origin', PREVIEW_ORIGIN]).ok, false);
  assert.equal(parseDevOpenArgs(['--origin', PREVIEW_ORIGIN, '--preview']).ok, false);
});

test('プレビューには Access の両方の値が必要で、理由に秘密を含めない', () => {
  for (const env of [
    {},
    { CF_ACCESS_CLIENT_ID: 'secret-id' },
    { CF_ACCESS_CLIENT_SECRET: 'secret-value' },
    { ...ACCESS_ENV, CF_ACCESS_CLIENT_ID: ' ' },
  ]) {
    const reason = failureReason(resolveDevOpenTarget(['--origin', PREVIEW_ORIGIN], env));
    assert.match(reason, /両方が必要/);
    assert.doesNotMatch(reason, /secret-id|secret-value/);
  }
});

test('alias のラベルが63文字の origin は受け付け、64文字は断る', () => {
  const origin = (digits: number) => `https://pr-${'1'.repeat(digits)}-banmen-preview.ucan-lab.workers.dev`;
  assert.equal(isPreviewOrigin(origin(45)), true);
  assert.equal(isPreviewOrigin(origin(46)), false);
});
