import { describe, expect, test, vi } from 'vitest';
import {
  PreviewBuildQueue,
  type PreviewQueueDeps,
  type PreviewQueueState,
} from '../src/server/preview-trigger/queue.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const first = { issue: '42', pr: 81, branch: '42-report', sha: 'a'.repeat(40) } satisfies PreviewRequest;
const second = { ...first, sha: 'b'.repeat(40) };
const third = { ...first, sha: 'c'.repeat(40) };

function harness() {
  let saved: PreviewQueueState | undefined;
  let head: PreviewRequest | null = first;
  let buildCount = 0;
  const finishedIds = new Set<string>();
  const deps = {
    read: vi.fn(async () => structuredClone(saved)),
    write: vi.fn(async (state: PreviewQueueState) => {
      saved = structuredClone(state);
    }),
    schedule: vi.fn<PreviewQueueDeps['schedule']>(async () => {}),
    current: vi.fn<PreviewQueueDeps['current']>(async () => head),
    start: vi.fn<PreviewQueueDeps['start']>(async () => `build-${++buildCount}`),
    finished: vi.fn(async (buildId: string) => finishedIds.has(buildId)),
  } satisfies PreviewQueueDeps;
  // 呼び出しのたびにキューを組み直し、インスタンスのメモリにだけ状態を置いても通らないようにする。
  return {
    deps,
    queue: () => new PreviewBuildQueue(deps),
    setHead: (request: PreviewRequest | null) => {
      head = request;
    },
    finish: (id: string) => finishedIds.add(id),
    state: () => saved,
  };
}

describe('同じ Issue のプレビュービルドを順に実行する', () => {
  test('イベントを受け付けると実行を予約し、その場ではビルドを起動しない', async () => {
    const h = harness();

    await h.queue().enqueue(first);

    expect(h.deps.schedule).toHaveBeenCalled();
    expect(h.deps.start).not.toHaveBeenCalled();
    await h.queue().run();
    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);
  });

  test('完了前は次を起動せず、後続のイベントは最新の head にまとめる', async () => {
    const h = harness();
    await h.queue().enqueue(first);
    await h.queue().run();

    h.setHead(second);
    await h.queue().enqueue(second);
    h.setHead(third);
    await h.queue().enqueue(third);
    h.deps.schedule.mockClear();
    await h.queue().run();

    expect(h.deps.finished).toHaveBeenCalledWith('build-1');
    expect(h.deps.start.mock.calls).toEqual([[first]]);
    expect(h.deps.schedule).toHaveBeenCalled();

    h.finish('build-1');
    await h.queue().run();

    expect(h.deps.start.mock.calls).toEqual([[first], [third]]);
  });

  test('ビルド前に PR の現在の head を読み、古いイベントの SHA は起動しない', async () => {
    const h = harness();
    await h.queue().enqueue(first);
    h.setHead(second);

    await h.queue().run();

    expect(h.deps.current).toHaveBeenCalledExactlyOnceWith(first);
    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(second);
  });

  test('実行を待つ間に PR が閉じられたら起動しない', async () => {
    const h = harness();
    await h.queue().enqueue(first);
    h.setHead(null);

    await h.queue().run();

    expect(h.deps.current).toHaveBeenCalledExactlyOnceWith(first);
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  test('同じ head の再送は、ビルド中と完了後のいずれも重複起動しない', async () => {
    const h = harness();
    await h.queue().enqueue(first);
    await h.queue().run();

    await h.queue().enqueue(first);
    await h.queue().run();
    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);

    h.finish('build-1');
    await h.queue().run();
    await h.queue().enqueue(first);
    await h.queue().run();

    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);
  });

  test('起動が届いたか不明なら状態を残し、後続の実行で二重起動しない', async () => {
    const h = harness();
    h.deps.start.mockRejectedValueOnce(new Error('応答を受け取れなかった'));
    await h.queue().enqueue(first);

    // 起動エラーを伝えるか記録だけにとどめるかにかかわらず、二重起動を防ぐ状態が必要。
    await Promise.allSettled([h.queue().run()]);

    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);
    expect(h.state()?.active).toEqual({ request: first, id: null });

    h.setHead(second);
    await h.queue().enqueue(second);
    await h.queue().run();

    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);
  });
});
