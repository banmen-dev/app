import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { NARROW_VIEWPORT, setCaptureViewport } from '../e2e/screen-capture.ts';
import { comparisonBands } from './screen-review-images.ts';
import { reviewCaptureTime, screenReviewOptions, screenReviewOutput } from './screen-review-options.ts';
import { serveReference } from './screen-review-runtime.ts';

test('画面名だけなら対応する状態を選び、周と除外の指定を受け取る', () => {
  assert.deepEqual(screenReviewOptions(['today']), {
    screen: 'today',
    state: 'list',
    round: '1',
    exclusions: undefined,
  });
  assert.deepEqual(screenReviewOptions(['today', 'list', '--round', '2', '--exclusions', 'matches.md']), {
    screen: 'today',
    state: 'list',
    round: '2',
    exclusions: 'matches.md',
  });
});

test('組の無い画面・状態と採点範囲外の周では撮影を始めない', () => {
  for (const args of [[], ['backlog'], ['today', 'empty'], ['today', 'list', 'list'], ['today', '--round', '4']])
    assert.throws(() => screenReviewOptions(args));
});

function pageWithWidths(widths: number[]) {
  let attempts = 0;
  return {
    page: {
      async setViewportSize(size: typeof NARROW_VIEWPORT) {
        assert.deepEqual(size, NARROW_VIEWPORT);
        attempts++;
      },
      async evaluate() {
        return widths[attempts - 1];
      },
    } as unknown as Page,
    attempts: () => attempts,
  };
}

test('画面幅が一致するまで1回だけ撮り直す', async () => {
  const first = pageWithWidths([390]);
  await setCaptureViewport(first.page, NARROW_VIEWPORT);
  assert.equal(first.attempts(), 1);
  const retry = pageWithWidths([980, 390]);
  await setCaptureViewport(retry.page, NARROW_VIEWPORT);
  assert.equal(retry.attempts(), 2);
  const mismatch = pageWithWidths([980, 414, 390]);
  await assert.rejects(setCaptureViewport(mismatch.page, NARROW_VIEWPORT), /2回目: 414px/);
  assert.equal(mismatch.attempts(), 2);
});

test('長い比較画像は行が読めるように境界を重ねて縦に分ける', () => {
  assert.deepEqual(comparisonBands(900), [{ offset: 0, height: 900 }]);
  assert.deepEqual(comparisonBands(1801), [
    { offset: 0, height: 900 },
    { offset: 836, height: 900 },
    { offset: 1672, height: 129 },
  ]);
});

test('撮影の時計は実行時刻以前の直近の水曜10時（日本時間）に固定する', () => {
  assert.equal(reviewCaptureTime(new Date('2026-11-22T03:00:00Z')).toISOString(), '2026-11-18T01:00:00.000Z');
  assert.equal(reviewCaptureTime(new Date('2026-11-18T00:59:59Z')).toISOString(), '2026-11-11T01:00:00.000Z');
  assert.equal(reviewCaptureTime(new Date('2026-11-18T01:00:00Z')).toISOString(), '2026-11-18T01:00:00.000Z');
});

test('見本の組織のマークを WebP で配り、見本の外のファイルを配らない', async () => {
  const reference = await serveReference(fileURLToPath(new URL('..', import.meta.url)));
  try {
    const mark = await fetch(reference.origin + '/brand/master/symbol.webp');
    assert.equal(mark.status, 200);
    assert.equal(mark.headers.get('content-type'), 'image/webp');
    assert.equal(
      Buffer.from(await mark.arrayBuffer())
        .subarray(8, 12)
        .toString(),
      'WEBP',
    );
    assert.equal((await fetch(reference.origin + '/%2e%2e%2fpackage.json')).status, 404);
  } finally {
    reference.close();
  }
});

test('撮影成果物は E2E の出力ディレクトリの外に置く', () => {
  const root = process.cwd();
  const output = screenReviewOutput(root, screenReviewOptions(['today', 'list', '--round', '2']));
  assert.equal(relative(root, output), ['screen-review-results', 'today', 'list', '2'].join('/'));
  assert.ok(relative(resolve(root, 'test-results'), output).startsWith('..'));
});
