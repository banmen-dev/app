import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import Progress from './Progress.svelte';

const body = (props: Parameters<typeof Progress>[1]) => render(Progress, { props }).body;

test('既存のポイント表示には目盛りも割合も足さない', () => {
  const html = body({ done: 8, all: 31 });
  expect(html).toContain('8 / 31 pt');
  expect(html).not.toContain('progress-marker');
  expect(html).not.toContain('pt（26%）');
});

test('完了割合の棒と経過目盛りを別々の位置に描き、両方を読み上げる', () => {
  const html = body({ done: 8, all: 31, detailed: true, markerPercent: 57, markerLabel: '経過 8 / 14 日（57%）' });
  expect(html).toContain('width: 26%');
  expect(html).toContain('left: 57%');
  expect(html).toContain('aria-label="完了 8 / 31 pt（26%）、経過 8 / 14 日（57%）"');
  expect(html).toContain('class="progress-marker"');
});

test('合計が0なら棒を空にし、完了割合は出さず経過は示す', () => {
  const html = body({ done: 0, all: 0, detailed: true, markerPercent: 100, markerLabel: '経過 14 / 14 日（100%）' });
  expect(html).toContain('width: 0%');
  expect(html).toContain('完了 0 / 0 pt');
  expect(html).not.toContain('pt（');
  expect(html).toContain('left: 100%');
});

test.each([-10, 0, 100, 110])('目盛り %s は棒の両端に収める', (markerPercent) => {
  const html = body({ done: 5, all: 5, markerPercent });
  expect(html).toContain(`left: ${Math.max(0, Math.min(100, markerPercent))}%`);
  expect(html).toContain('width: 100%');
});
