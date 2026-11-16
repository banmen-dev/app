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
