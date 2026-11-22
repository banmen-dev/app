import { afterEach, expect, test, vi } from 'vitest';
import {
  PreviewBuildQueue,
  type PreviewQueueDeps,
  type PreviewQueueState,
} from '../src/server/preview-trigger/queue.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const first = { issue: '42', pr: 81, branch: '42-report', sha: 'a'.repeat(40) } satisfies PreviewRequest;
const next = { ...first, sha: 'b'.repeat(40) };
const attemptedAt = 1_797_402_000_000;
const buildId = '023e105f-2f42-4f8b-a1c1-73f6a2a30c0f';
const nextBuildId = 'b5d30b08-7b06-493a-9199-addbbd78fb42';

function harness(initial: PreviewQueueState) {
  let saved = structuredClone(initial);
  let alarmAt: number | null = null;
  let tail = Promise.resolve();
  const deps = {
    read: async () => structuredClone(saved),
    write: async (state: PreviewQueueState) => {
      saved = structuredClone(state);
    },
    schedule: async (delay: number) => {
      const at = Date.now() + delay;
      if (alarmAt === null || at < alarmAt) alarmAt = at;
    },
    withStorage<T>(operation: () => Promise<T>): Promise<T> {
      const done = tail.then(operation);
      tail = done.then(
        () => {},
        () => {},
      );
      return done;
    },
    current: vi.fn<PreviewQueueDeps['current']>(async (request) => request),
    start: vi.fn<PreviewQueueDeps['start']>(async () => nextBuildId),
    finished: vi.fn<PreviewQueueDeps['finished']>(async () => false),
    verifyRecovery: vi.fn<NonNullable<PreviewQueueDeps['verifyRecovery']>>(async () => true),
  } satisfies PreviewQueueDeps;
  const queue = new PreviewBuildQueue(deps);
  return {
    deps,
    queue,
    state: () => structuredClone(saved),
    alarmAt: () => alarmAt,
    alarm: (instance = queue) => {
      alarmAt = null;
      return instance.run();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

test('a superseding webhook whose alarm is consumed during polling still waits for the prior build to stop', async () => {
  const h = harness({ active: { request: first, id: buildId, attemptedAt } });
  const polling = Promise.withResolvers<void>();
  const pollResponse = Promise.withResolvers<boolean>();
  h.deps.finished.mockImplementationOnce(async () => {
    polling.resolve();
    return pollResponse.promise;
  });

  const running = h.alarm();
  await polling.promise;
  try {
    await h.queue.enqueue(next);
    await h.alarm();
    expect(h.deps.finished).toHaveBeenCalledExactlyOnceWith(buildId);
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(h.state().pending).toEqual(next);
  } finally {
    pollResponse.resolve(false);
    await running;
  }
  expect(h.alarmAt()).not.toBeNull();
  expect(h.deps.start).not.toHaveBeenCalled();

  h.deps.finished.mockResolvedValueOnce(true);
  await h.alarm();
  expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(next);
  expect(h.state()).toMatchObject({ last: first, active: { request: next, id: nextBuildId } });
});

test('an ambiguous POST survives queue reinitialization without starting the newer pending request', async () => {
  const h = harness({ pending: first });
  h.deps.start.mockRejectedValueOnce(new Error('response unavailable'));
  await expect(h.alarm()).rejects.toThrow('response unavailable');
  const restarted = new PreviewBuildQueue(h.deps);
  await restarted.enqueue(next);
  await h.alarm(restarted);

  expect(h.deps.start).toHaveBeenCalledExactlyOnceWith(first);
  const attempt = await restarted.status();
  expect(attempt).toEqual({ sha: first.sha, attemptedAt: expect.any(Number) });
  expect(h.state().pending).toEqual(next);
  if (!attempt) throw new Error('Expected an ambiguous attempt after reinitialization');
  expect(await restarted.recover({ ...attempt, resolution: 'not-started' })).toBe(true);
  await h.alarm(restarted);

  expect(h.deps.start.mock.calls).toEqual([[first], [next]]);
  expect(h.state().active).toMatchObject({ request: next, id: nextBuildId });
});

test('an outstanding verification cannot attach to a newer ambiguous attempt of the same SHA and timestamp', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(attemptedAt);
  const h = harness({ active: { request: first, id: null, attemptedAt } });
  const verifying = Promise.withResolvers<void>();
  const verificationResponse = Promise.withResolvers<boolean>();
  h.deps.verifyRecovery.mockImplementationOnce(async () => {
    verifying.resolve();
    return verificationResponse.promise;
  });
  const attempt = { sha: first.sha, attemptedAt };
  const attach = h.queue.recover({ ...attempt, resolution: 'attach', buildId });
  await verifying.promise;
  try {
    expect(await h.queue.recover({ ...attempt, resolution: 'not-started' })).toBe(true);
    h.deps.start.mockRejectedValueOnce(new Error('second response unavailable'));
    await expect(h.alarm()).rejects.toThrow('second response unavailable');
  } finally {
    verificationResponse.resolve(true);
  }

  expect(await attach).toBe(false);
  expect(h.state().active).toMatchObject({ request: first, id: null });
});
