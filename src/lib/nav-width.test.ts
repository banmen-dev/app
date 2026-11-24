import { describe, expect, test } from 'vitest';
import { NAV_WIDTH_DRAG_THRESHOLD, draggedNavWidth, keyedNavWidth, releasedNavWidth } from './nav-width.ts';

describe('境目のドラッグで決める幅', () => {
  test('押して離しただけ、または閾値（3px）未満のずれは幅を変えない（ダブルクリックの間のずれで前の幅を失わない）', () => {
    expect(NAV_WIDTH_DRAG_THRESHOLD).toBe(3);
    expect(draggedNavWidth(300, 0, 1280)).toBeNull();
    expect(draggedNavWidth(300, 2, 1280)).toBeNull();
    expect(draggedNavWidth(300, -2.9, 1280)).toBeNull();
  });

  test('閾値以上は動かした分だけ変え、範囲に収める', () => {
    expect(draggedNavWidth(300, 3, 1280)).toBe(303);
    expect(draggedNavWidth(300, -3, 1280)).toBe(297);
    expect(draggedNavWidth(300, -500, 1280)).toBe(200);
    expect(draggedNavWidth(300, 500, 1280)).toBe(480);
    expect(draggedNavWidth(300, 500, 900)).toBe(360);
  });
});

describe('境目のキーで決める幅', () => {
  test('左右の矢印は 16px ずつ、Home と End は下限と画面の幅での上限', () => {
    expect(keyedNavWidth('ArrowRight', 240, 1280)).toBe(256);
    expect(keyedNavWidth('ArrowLeft', 240, 1280)).toBe(224);
    expect(keyedNavWidth('Home', 300, 1280)).toBe(200);
    expect(keyedNavWidth('End', 300, 1280)).toBe(480);
    expect(keyedNavWidth('End', 300, 900)).toBe(360);
  });

  test('ほかのキーと、端に張り付いて幅が変わらないキーは null（覚えた広い幅を上書きしない）', () => {
    expect(keyedNavWidth('Enter', 240, 1280)).toBeNull();
    expect(keyedNavWidth('a', 240, 1280)).toBeNull();
    // 覚えた幅 480 を 900px の窓で上限 360 で見ているとき、右の矢印も End も見た目は変わらない
    expect(keyedNavWidth('ArrowRight', 360, 900)).toBeNull();
    expect(keyedNavWidth('End', 360, 900)).toBeNull();
    expect(keyedNavWidth('ArrowLeft', 200, 1280)).toBeNull();
    expect(keyedNavWidth('Home', 200, 1280)).toBeNull();
    // 上限から左へは変わる
    expect(keyedNavWidth('ArrowLeft', 360, 900)).toBe(344);
  });
});

describe('境目を離したときの幅', () => {
  test('見えている幅が掴んだときと同じなら null（呼ぶ側は覚えた広い幅に戻して覚え直さない）', () => {
    // 覚えた 480 を 900px の窓（上限 360）で見ていて、右へ動かしても 360 のまま
    expect(releasedNavWidth(360, 360)).toBeNull();
    // 動かしてから元の幅へ戻して離した
    expect(releasedNavWidth(300, 300)).toBeNull();
  });

  test('見えている幅が変わったら、その幅を覚える', () => {
    expect(releasedNavWidth(360, 300)).toBe(300);
    expect(releasedNavWidth(240, 340)).toBe(340);
  });
});
