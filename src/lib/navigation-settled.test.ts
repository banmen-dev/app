import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 画面の移動が決着してから読み直す（invalidate）順を確かめる（#1331）
const calls: string[] = [];
const state = vi.hoisted(() => ({
  navigation: null as { complete: Promise<void>; willUnload: boolean } | null,
}));
vi.mock('$app/navigation', () => ({
  invalidate: vi.fn(async (resource: string) => {
    calls.push(`invalidate ${resource}`);
  }),
}));
// SvelteKit の navigating と同じく、移動の途中だけ complete と willUnload を返す
vi.mock('$app/state', () => ({
  navigating: {
    get complete() {
      return state.navigation?.complete ?? null;
    },
    get willUnload() {
      return state.navigation?.willUnload ?? null;
    },
  },
}));

const { invalidateAfterNavigation } = await import('./navigation-settled.ts');

type Controls = { finish: (clear?: boolean) => void; cancel: () => void };

// 移動を始める。finish か cancel を呼ぶまで complete が解けない。
// SvelteKit は、後の移動が前の移動を置き換える（navigating は後の移動になる）
function navigate(url: string, willUnload = false): Controls {
  let fulfil!: () => void;
  let reject!: (error: Error) => void;
  const complete = new Promise<void>((resolve, fail) => {
    fulfil = resolve;
    reject = fail;
  });
  complete.catch(() => undefined);
  const navigation = { complete, willUnload };
  state.navigation = navigation;
  calls.push(`navigate ${url}`);
  const clear = () => {
    if (state.navigation === navigation) state.navigation = null;
  };
  return {
    // clear が偽なら、決着した後も navigating を残す（SvelteKit が下ろすまでの間）
    finish: (shouldClear = true) => {
      calls.push(`navigated ${url}`);
      fulfil();
      if (shouldClear) clear();
    },
    cancel: () => {
      reject(new Error('navigation aborted'));
      clear();
    },
  };
}

// 待っている読み直しが進めるだけ、タスクを回す
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('invalidateAfterNavigation', () => {
  beforeEach(() => {
    calls.length = 0;
    state.navigation = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('移動が無ければ、すぐに読み直す', async () => {
    await invalidateAfterNavigation(['app:backlog-tree', 'app:epic-detail']);
    expect(calls).toEqual(['invalidate app:backlog-tree', 'invalidate app:epic-detail']);
  });

  it('閉じる移動の途中に保存が返ったら、移動が決着してから読み直す', async () => {
    const closing = navigate('/aoba/w/1/epics/2');
    const reload = invalidateAfterNavigation(['app:epic-detail']);
    await flush();
    expect(calls).toEqual(['navigate /aoba/w/1/epics/2']);

    closing.finish();
    await reload;
    expect(calls).toEqual(['navigate /aoba/w/1/epics/2', 'navigated /aoba/w/1/epics/2', 'invalidate app:epic-detail']);
  });

  it('決着した後に navigating が残っていても、同じ移動を待ち続けない', async () => {
    const closing = navigate('/aoba/w/1');
    const reload = invalidateAfterNavigation(['app:backlog-tree']);
    closing.finish(false);
    await reload;
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
  });

  it('移動が取りやめられても、読み直しは止めない', async () => {
    const closing = navigate('/aoba/w/1');
    const reload = invalidateAfterNavigation(['app:backlog-tree']);
    closing.cancel();
    await reload;
    expect(calls).toEqual(['navigate /aoba/w/1', 'invalidate app:backlog-tree']);
  });

  it('移動の途中に次の移動が始まったら（前の移動は取りやめになる）、次の移動も待つ', async () => {
    const first = navigate('/aoba/w/1?task=a');
    const reload = invalidateAfterNavigation(['app:backlog-tree']);
    await flush();
    const second = navigate('/aoba/w/1?task=b');
    first.cancel();
    await flush();
    expect(calls).not.toContain('invalidate app:backlog-tree');

    second.finish();
    await reload;
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
  });

  it('ページを離れる移動は待たない（残るとブラウザが決めると complete が解けない）', async () => {
    navigate('https://example.com/', true);
    await invalidateAfterNavigation(['app:backlog-tree']);
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
  });

  it('移動が決着しなくても、上限の10秒を過ぎたら読み直す', async () => {
    vi.useFakeTimers();
    navigate('/aoba/w/1');
    const reload = invalidateAfterNavigation(['app:backlog-tree']);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).not.toContain('invalidate app:backlog-tree');
    await vi.advanceTimersByTimeAsync(1);
    await reload;
    expect(calls.at(-1)).toBe('invalidate app:backlog-tree');
  });

  it('待つ間に読み直す理由が無くなったら（別の画面へ移った）、読み直さない', async () => {
    let here = true;
    const leaving = navigate('/aoba/w/2');
    const reload = invalidateAfterNavigation(['app:backlog-tree'], () => here);
    here = false;
    leaving.finish();
    await reload;
    expect(calls).not.toContain('invalidate app:backlog-tree');
  });
});
