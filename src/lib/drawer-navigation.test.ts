import { beforeEach, describe, expect, it, vi } from 'vitest';

// 引き出しの移動（goto）が終わってから読み直す（invalidate）順を確かめる（#1331）
const calls: string[] = [];
const gotos: { resolve: () => void; reject: (error: Error) => void }[] = [];
vi.mock('$app/navigation', () => ({
  invalidate: vi.fn(async (resource: string) => {
    calls.push(`invalidate ${resource}`);
  }),
}));

const { invalidateAfterDrawerNavigation, trackDrawerNavigation } = await import('./drawer-navigation.ts');

// goto の代わり。終わらせるまで待つ移動を返す
function drawerGoto(url: string): Promise<void> {
  return trackDrawerNavigation(
    new Promise<void>((resolve, reject) => {
      calls.push(`goto ${url}`);
      gotos.push({
        resolve: () => {
          calls.push(`goto done ${url}`);
          resolve();
        },
        reject,
      });
    }),
  );
}

// 待っている読み直しが進めるだけ、マイクロタスクを回す
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('invalidateAfterDrawerNavigation', () => {
  beforeEach(() => {
    calls.length = 0;
    gotos.length = 0;
  });

  it('移動が無ければ、すぐに読み直す', async () => {
    await invalidateAfterDrawerNavigation('app:backlog-tree', 'app:epic-detail');
    expect(calls).toEqual(['invalidate app:backlog-tree', 'invalidate app:epic-detail']);
  });

  it('閉じる移動の途中に保存が返ったら、移動が終わってから読み直す', async () => {
    const closing = drawerGoto('/aoba/w/1/epics/2');
    const reload = invalidateAfterDrawerNavigation('app:epic-detail');
    await flush();
    expect(calls).toEqual(['goto /aoba/w/1/epics/2']);

    gotos[0].resolve();
    await Promise.all([closing, reload]);
    expect(calls).toEqual(['goto /aoba/w/1/epics/2', 'goto done /aoba/w/1/epics/2', 'invalidate app:epic-detail']);
  });

  it('移動が取りやめられても（失敗）、読み直しは止めない', async () => {
    const closing = drawerGoto('/aoba/w/1');
    const reload = invalidateAfterDrawerNavigation('app:backlog-tree');
    gotos[0].reject(new Error('navigation aborted'));
    await expect(closing).rejects.toThrow('navigation aborted');
    await reload;
    expect(calls).toEqual(['goto /aoba/w/1', 'invalidate app:backlog-tree']);
  });

  it('待つ間に次の移動が始まったら、それも待つ', async () => {
    const first = drawerGoto('/aoba/w/1?task=a');
    const reload = invalidateAfterDrawerNavigation('app:backlog-tree');
    const second = drawerGoto('/aoba/w/1?task=b');
    gotos[0].resolve();
    await first;
    await flush();
    expect(calls).not.toContain('invalidate app:backlog-tree');

    gotos[1].resolve();
    await Promise.all([second, reload]);
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
  });

  it('終わった移動は覚えておかない。次の読み直しは待たない', async () => {
    const closing = drawerGoto('/aoba/w/1');
    gotos[0].resolve();
    await closing;
    calls.length = 0;
    await invalidateAfterDrawerNavigation('app:backlog-tree');
    expect(calls).toEqual(['invalidate app:backlog-tree']);
  });
});
