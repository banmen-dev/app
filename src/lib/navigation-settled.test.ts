import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 画面の移動が終わってから読み直す（invalidate）順を確かめる（#1331）
const calls: string[] = [];
vi.mock('$app/navigation', () => ({
  invalidate: vi.fn(async (resource: string) => {
    calls.push(`invalidate ${resource}`);
  }),
}));

const { invalidateAfterNavigation, trackNavigation } = await import('./navigation-settled.ts');

type Controls = { finish: () => void; cancel: () => void };

// beforeNavigate に渡る移動の代わり。finish か cancel を呼ぶまで complete が解けない
function navigate(url: string, willUnload = false): Controls {
  let fulfil!: () => void;
  let reject!: (error: Error) => void;
  const complete = new Promise<void>((resolve, fail) => {
    fulfil = resolve;
    reject = fail;
  });
  complete.catch(() => undefined);
  calls.push(`navigate ${url}`);
  trackNavigation({ complete, willUnload });
  return {
    finish: () => {
      calls.push(`navigated ${url}`);
      fulfil();
    },
    cancel: () => reject(new Error('navigation cancelled')),
  };
}

// 待っている読み直しが進めるだけ、タスクを回す
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('invalidateAfterNavigation', () => {
  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('移動が無ければ、すぐに読み直す', async () => {
    await invalidateAfterNavigation('app:backlog-tree', 'app:epic-detail');
    expect(calls).toEqual(['invalidate app:backlog-tree', 'invalidate app:epic-detail']);
  });

  it('閉じる移動の途中に保存が返ったら、移動が終わってから読み直す', async () => {
    const closing = navigate('/aoba/w/1/epics/2');
    const reload = invalidateAfterNavigation('app:epic-detail');
    await flush();
    expect(calls).toEqual(['navigate /aoba/w/1/epics/2']);

    closing.finish();
    await reload;
    expect(calls).toEqual(['navigate /aoba/w/1/epics/2', 'navigated /aoba/w/1/epics/2', 'invalidate app:epic-detail']);
  });

  it('移動が取りやめられても、読み直しは止めない', async () => {
    const closing = navigate('/aoba/w/1');
    const reload = invalidateAfterNavigation('app:backlog-tree');
    closing.cancel();
    await reload;
    expect(calls).toEqual(['navigate /aoba/w/1', 'invalidate app:backlog-tree']);
  });

  it('待つ間に次の移動が始まったら、それも待つ', async () => {
    const first = navigate('/aoba/w/1?task=a');
    const reload = invalidateAfterNavigation('app:backlog-tree');
    const second = navigate('/aoba/w/1?task=b');
    first.finish();
    await flush();
    expect(calls).not.toContain('invalidate app:backlog-tree');

    second.finish();
    await reload;
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
  });

  it('終わった移動は覚えておかない。次の読み直しは待たない', async () => {
    navigate('/aoba/w/1').finish();
    await flush();
    calls.length = 0;
    await invalidateAfterNavigation('app:backlog-tree');
    expect(calls).toEqual(['invalidate app:backlog-tree']);
  });

  it('ページを離れる移動は覚えない（残るとブラウザが決めると complete が解けない）', async () => {
    navigate('https://example.com/', true);
    await invalidateAfterNavigation('app:backlog-tree');
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
  });

  it('移動が決着しなくても、上限の10秒を過ぎたら読み直す', async () => {
    vi.useFakeTimers();
    const stuck = navigate('/aoba/w/1');
    const reload = invalidateAfterNavigation('app:backlog-tree');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).not.toContain('invalidate app:backlog-tree');
    await vi.advanceTimersByTimeAsync(1);
    await reload;
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
    stuck.finish();
    await vi.advanceTimersByTimeAsync(0);
  });
});
