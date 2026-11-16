import { expect, test } from 'vitest';
import { ReopenKeyGuard } from './reopen-key.ts';

test('通常の未完了カードとメニューの操作ではキー反復を変えない', () => {
  const guard = new ReopenKeyGuard();
  expect(guard.suppress(true)).toBe(false);
  guard.start(undefined);
  expect(guard.suppress(true)).toBe(false);
});

test('完了から戻したキーは、カードの再描画後も同じ左キーが離れるまで反復を止める', () => {
  const guard = new ReopenKeyGuard();
  guard.start(false);
  expect(guard.suppress(true)).toBe(true);
  expect(guard.suppress(false)).toBe(false);
  guard.release('Alt');
  expect(guard.suppress(true)).toBe(true);
  guard.release('ArrowLeft');
  expect(guard.suppress(true)).toBe(false);
});

test('blurやワークスペース遷移でリセットすると古い押下を持ち越さない', () => {
  const guard = new ReopenKeyGuard();
  guard.start(false);
  guard.reset();
  expect(guard.suppress(true)).toBe(false);
});
