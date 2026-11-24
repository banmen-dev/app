import { describe, expect, test } from 'vitest';
import { overWipLimit } from './column.ts';

describe('overWipLimit', () => {
  test('上限ちょうどは超えていない。1件多ければ超えている。上限なしは超えない', () => {
    expect(overWipLimit(3, 3)).toBe(false);
    expect(overWipLimit(4, 3)).toBe(true);
    expect(overWipLimit(0, 1)).toBe(false);
    expect(overWipLimit(0, null)).toBe(false);
    expect(overWipLimit(99, null)).toBe(false);
  });
});
