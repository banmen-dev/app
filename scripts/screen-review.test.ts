import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { NARROW_VIEWPORT, setCaptureViewport } from '../e2e/screen-capture.ts';
import { comparisonBands, referenceFontFailure, reviewImagePaths } from './screen-review-images.ts';
import { motionAnimationSelectors } from './screen-review-motion.ts';
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
  assert.deepEqual(comparisonBands(901), [
    { offset: 0, height: 483 },
    { offset: 419, height: 482 },
  ]);
  assert.deepEqual(comparisonBands(1801), [
    { offset: 0, height: 643 },
    { offset: 579, height: 643 },
    { offset: 1158, height: 643 },
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
  assert.equal(relative(root, output), join('screen-review-results', 'today', 'list', '2'));
  assert.ok(relative(resolve(root, 'test-results'), output).startsWith(`..${sep}`));
});

test('db:seed の撮影オプションで引数が欠けていれば D1 を変更する前に止まる', () => {
  const script = fileURLToPath(new URL('./db-seed.ts', import.meta.url));
  for (const [args, message] of [
    [['--env-file'], /--env-file にファイルを指定/],
    [['--save-sql', 'output.sql'], /--save-sql には --persist-to と出力先を指定/],
  ] as const) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test('設計文書の見出しが欠けていれば、ロックと出力を作る前に見出しの名前を出して止まる', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'screen-review-design-'));
  try {
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'docs/design.md'), '## デザイン原則\n本文\n');
    const script = fileURLToPath(new URL('./screen-review.ts', import.meta.url));
    const result = spawnSync(process.execPath, [script, 'today', 'list'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /どのテーマにも共通すること/);
    assert.equal(existsSync(join(cwd, 'screen-review-results')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('動きを減らす設定は、判子・通知の領域とその子孫を観測する', () => {
  assert.deepEqual(motionAnimationSelectors('reduce'), {
    stamp: '.entry.is-done, .entry.is-done *',
    toast: '.toasts, .toasts *',
  });
  assert.deepEqual(motionAnimationSelectors('no-preference'), {
    stamp: '.hanko',
    toast: '.toast',
  });
});

test('見本の外部フォントの通信と HTTP の失敗だけを記録する', () => {
  const stylesheet = 'https://fonts.googleapis.com/css2';
  const font = 'https://fonts.gstatic.com/font.woff2';
  assert.equal(referenceFontFailure(stylesheet), '外部フォントの通信に失敗');
  assert.equal(referenceFontFailure(font, 503), '外部フォントの HTTP 503');
  assert.equal(referenceFontFailure(font, 304), undefined);
  assert.equal(referenceFontFailure('https://fonts.googleapis.com.example.com/font', 404), undefined);
  assert.equal(referenceFontFailure('https://example.com/image.png'), undefined);
  assert.equal(referenceFontFailure('not a URL', 400), undefined);
});

test('採点役に渡す画像は、pairs/ の全画像と motion/ の合成画像を絶対パスで並べ、コマは含めない', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'screen-review-paths-'));
  try {
    mkdirSync(join(directory, 'pairs'));
    mkdirSync(join(directory, 'motion'));
    for (const file of ['pairs/light-1280.png', 'pairs/light-390-1.png', 'pairs/light-390-2.png'])
      writeFileSync(join(directory, file), '');
    for (const file of [
      'motion/dark-stamp.png',
      'motion/dark-stamp-1.png',
      'motion/dark-stamp-2.png',
      'motion/results.json',
    ])
      writeFileSync(join(directory, file), '');
    assert.deepEqual(
      await reviewImagePaths(directory),
      ['pairs/light-1280.png', 'pairs/light-390-1.png', 'pairs/light-390-2.png', 'motion/dark-stamp.png'].map((file) =>
        resolve(directory, file),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
