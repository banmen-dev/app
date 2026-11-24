import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
vi.mock('$app/paths', () => ({ asset: (path: string) => path }));
import LoadingSheet from './components/LoadingSheet.svelte';

test('ダッシュボードの待ちは広い紙の2列で、組織の枠を出さない', () => {
  const { body } = render(LoadingSheet, { props: { dashboard: true } });
  expect(body).toContain('gate is-wide');
  expect(body).toContain('dashboard-main');
  expect(body).toContain('dashboard-side');
  expect(body).not.toMatch(/class="[^"]*\bbinding(?:\s|")/);
});

test('ほかの枠の外の待ちは狭い紙を保つ', () => {
  const { body } = render(LoadingSheet);
  expect(body).not.toContain('is-wide');
  expect(body).not.toContain('dashboard-main');
});

test('小見出しを 760px 以下だけに出す画面では、骨組みの小見出しの帯にも is-narrow-only を付ける（#1509）', () => {
  const narrow = render(LoadingSheet, { props: { shape: 'list', narrowEyebrow: true } }).body;
  expect(narrow).toMatch(/class="skeleton-line is-eyebrow is-narrow-only"/);
  const always = render(LoadingSheet, { props: { shape: 'list' } }).body;
  expect(always).toMatch(/class="skeleton-line is-eyebrow"/);
  expect(always).not.toContain('is-narrow-only');
});

test('パンくずの帯は上の帯の外、本文の直前に置く（#1509）', () => {
  const { body } = render(LoadingSheet, { props: { shape: 'today' } });
  const topbar = body.match(/<div class="topbar"[^>]*>[\s\S]*?(?=<div class="binding")/)?.[0] ?? '';
  expect(topbar).toContain('is-search');
  expect(topbar).not.toContain('is-crumb');
  expect(body.replace(/<!--[^>]*-->/g, '')).toMatch(
    /<div class="sheet-crumbs"[^>]*><span class="skeleton-line is-crumb"><\/span><\/div>\s*<main\b/,
  );
});

test('組織の名前の帯は上の帯の検索とアカウントの間に置く（#1510）', () => {
  const { body } = render(LoadingSheet, { props: { shape: 'today' } });
  const binding = body.match(/<div class="binding"[\s\S]*?(?=<div class="sheet")/)?.[0] ?? '';
  expect(binding).not.toContain('is-org-name');
  const topbar = body.match(/<div class="topbar"[^>]*>[\s\S]*?(?=<div class="binding")/)?.[0] ?? '';
  expect(topbar).toMatch(/is-search[\s\S]*is-org-name[\s\S]*is-account/);
});

// 読み込んだ後の枠と同じく、全幅の上の帯を枠の先頭に置き、左端に開閉のボタンの帯とマークを並べる（#1511）
test('上の帯は枠の先頭にあり、左端に開閉のボタンの帯とマークを置く（#1511）', () => {
  const body = render(LoadingSheet, { props: { shape: 'today' } }).body.replace(/<!--[^>]*-->/g, '');
  expect(body).toMatch(
    /<div class="app skeleton-frame"[^>]*>\s*<div class="topbar" aria-hidden="true">\s*<div class="topbar-start">/,
  );
  expect(body).toMatch(
    /<div class="topbar-start"><span class="skeleton-line is-toggle"><\/span>\s*<span class="brand">/,
  );
  expect(body).not.toContain('binding-head');
});
