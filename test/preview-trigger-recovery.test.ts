import { describe, expect, test, vi } from 'vitest';
import {
  PreviewBuildQueue,
  type PreviewQueueDeps,
  type PreviewQueueState,
} from '../src/server/preview-trigger/queue.ts';
import * as queueModule from '../src/server/preview-trigger/queue.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const first = { issue: '42', pr: 81, branch: '42-report', sha: 'a'.repeat(40) } satisfies PreviewRequest;
const next = { ...first, sha: 'b'.repeat(40) };
const attemptedAt = 1_797_402_000_000;
const buildId = '023e105f-2f42-4f8b-a1c1-73f6a2a30c0f';

function harness(initial?: PreviewQueueState) {
  let saved = structuredClone(initial);
  const deps = {
    read: vi.fn(async () => structuredClone(saved)),
    write: vi.fn(async (state: PreviewQueueState) => {
      saved = structuredClone(state);
    }),
    schedule: vi.fn<PreviewQueueDeps['schedule']>(async () => {}),
    current: vi.fn<PreviewQueueDeps['current']>(async (request) => request),
    start: vi.fn<PreviewQueueDeps['start']>(async () => buildId),
    finished: vi.fn<PreviewQueueDeps['finished']>(async () => false),
    verifyRecovery: vi.fn<NonNullable<PreviewQueueDeps['verifyRecovery']>>(async () => true),
  } satisfies PreviewQueueDeps;
  return { deps, queue: () => new PreviewBuildQueue(deps), state: () => structuredClone(saved) };
}

function expectRetry(h: ReturnType<typeof harness>) {
  expect(h.deps.schedule).toHaveBeenCalled();
  const delay = h.deps.schedule.mock.calls.at(-1)?.[0];
  expect(delay).toBeGreaterThan(0);
  expect(Number.isFinite(delay)).toBe(true);
}

describe('ビルドの結果が分かる範囲に合わせて再試行する', () => {
  test('起動を明確に拒否されたら待機中の head を残し、次の試行で最新 head を確認する', async () => {
    const h = harness({ pending: first });
    expect(queueModule.PreviewBuildRejected).toBeTypeOf('function');
    h.deps.start.mockRejectedValueOnce(new queueModule.PreviewBuildRejected('明確な拒否'));

    await Promise.allSettled([h.queue().run()]);

    expect(h.state()?.active).toBeUndefined();
    expect(h.state()?.pending).toEqual(first);
    expectRetry(h);

    h.deps.current.mockResolvedValueOnce(next);
    await h.queue().run();

    expect(h.deps.start.mock.calls).toEqual([[first], [next]]);
    expect(h.state()?.active).toMatchObject({ request: next, id: buildId });
  });

  test('最新 head の照合が一時的に失敗したら待機状態を保って再予約する', async () => {
    const h = harness({ pending: first });
    h.deps.current.mockRejectedValueOnce(new Error('GitHub が応答しなかった'));

    await Promise.allSettled([h.queue().run()]);

    expect(h.state()).toEqual({ pending: first });
    expect(h.deps.start).not.toHaveBeenCalled();
    expectRetry(h);

    await h.queue().run();
    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);
  });

  test('実行中のビルド状況を一時的に読めなくても待機中の head を失わない', async () => {
    const initial = { active: { request: first, id: buildId, attemptedAt }, pending: next };
    const h = harness(initial);
    h.deps.finished.mockRejectedValueOnce(new Error('Cloudflare が応答しなかった'));

    await Promise.allSettled([h.queue().run()]);

    expect(h.state()).toEqual(initial);
    expect(h.deps.start).not.toHaveBeenCalled();
    expectRetry(h);

    h.deps.finished.mockResolvedValueOnce(true);
    await h.queue().run();
    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(next);
  });

  test('外部呼び出しの前に試行時刻を保存し、通信の結果が不明な間は再度起動しない', async () => {
    const h = harness({ pending: first });
    let atStart: PreviewQueueState['active'];
    h.deps.start.mockImplementationOnce(async () => {
      atStart = h.state()?.active;
      throw new Error('通信の結果が分からなかった');
    });

    await Promise.allSettled([h.queue().run()]);
    expect(atStart).toEqual({ request: first, id: null, attemptedAt: expect.any(Number) });
    expect(h.state()?.active?.attemptedAt).toBeGreaterThan(0);

    await h.queue().enqueue(next);
    await h.queue().run();

    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);
    expect(h.state()?.active).toMatchObject({ request: first, id: null });
    expect(h.state()?.pending).toEqual(next);
  });
});

describe('運用者が確認した不明な試行を復旧する', () => {
  const ambiguous = { request: first, id: null, attemptedAt };

  test('試行に対応するビルドを確認できたら採用し、停止後に次の head へ進む', async () => {
    const h = harness({ active: ambiguous, pending: next });
    const recovery = { sha: first.sha, attemptedAt, resolution: 'attach', buildId } as const;

    expect(await h.queue().recover(recovery)).toBe(true);

    expect(h.deps.verifyRecovery).toHaveBeenCalledExactlyOnceWith(buildId, first, attemptedAt);
    expect(h.state()?.active).toMatchObject({ request: first, id: buildId });
    expect(h.state()?.pending).toEqual(next);
    expect(h.deps.schedule).toHaveBeenCalled();
    await h.queue().run();
    expect(h.deps.finished).toHaveBeenCalledWith(buildId);
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(await h.queue().recover(recovery)).toBe(false);

    h.deps.finished.mockResolvedValueOnce(true);
    await h.queue().run();
    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(next);
  });

  test('ビルドを照合できない場合は採用せず、検査に失敗しても不明状態を保つ', async () => {
    const initial = { active: ambiguous, pending: next };
    const h = harness(initial);
    h.deps.verifyRecovery.mockResolvedValueOnce(false);

    expect(await h.queue().recover({ sha: first.sha, attemptedAt, resolution: 'attach', buildId })).toBe(false);

    expect(h.state()).toEqual(initial);
    expect(h.deps.schedule).not.toHaveBeenCalled();
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  test.each([
    { label: '違う SHA', sha: next.sha, time: attemptedAt },
    { label: '古い試行時刻', sha: first.sha, time: attemptedAt - 1 },
  ])('$label の操作は別の試行に適用しない', async ({ sha, time }) => {
    const initial = { active: ambiguous, pending: next };
    const h = harness(initial);

    expect(await h.queue().recover({ sha, attemptedAt: time, resolution: 'attach', buildId })).toBe(false);
    expect(await h.queue().recover({ sha, attemptedAt: time, resolution: 'not-started' })).toBe(false);
    expect(h.state()).toEqual(initial);
    expect(h.deps.verifyRecovery).not.toHaveBeenCalled();
    expect(h.deps.schedule).not.toHaveBeenCalled();
  });

  test('結果の分かる実行中のビルドには復旧を適用しない', async () => {
    const initial = { active: { ...ambiguous, id: buildId }, pending: next };
    const h = harness(initial);

    expect(await h.queue().recover({ sha: first.sha, attemptedAt, resolution: 'not-started' })).toBe(false);
    expect(h.state()).toEqual(initial);
    expect(h.deps.schedule).not.toHaveBeenCalled();
  });

  test.each([undefined, next])('開始されていないと確認されたら、待機 head を保って再予約する (%s)', async (pending) => {
    const initial = pending ? { active: ambiguous, pending } : { active: ambiguous };
    const h = harness(initial);

    expect(await h.queue().recover({ sha: first.sha, attemptedAt, resolution: 'not-started' })).toBe(true);
    expect(h.state()?.active).toBeUndefined();
    expect(h.state()?.pending).toEqual(pending ?? first);
    expect(h.deps.schedule).toHaveBeenCalled();
    expect(h.deps.start).not.toHaveBeenCalled();

    await h.queue().run();
    expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(pending ?? first);
  });
});
