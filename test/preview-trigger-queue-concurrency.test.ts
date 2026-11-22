import { expect, test, vi } from 'vitest';
import {
  PreviewBuildQueue,
  PreviewBuildRejected,
  type PreviewQueueState,
} from '../src/server/preview-trigger/queue.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const first = { issue: '42', pr: 81, branch: '42-report', sha: 'a'.repeat(40) } satisfies PreviewRequest;
const next = { ...first, sha: 'b'.repeat(40) };
const buildId = '023e105f-2f42-4f8b-a1c1-73f6a2a30c0f';

test('the latest request survives an explicit rejection during a different build start', async () => {
  let saved: PreviewQueueState | undefined = { pending: first };
  const postEntered = Promise.withResolvers<void>();
  const postResponse = Promise.withResolvers<string>();
  const queue = new PreviewBuildQueue({
    read: async () => structuredClone(saved),
    write: async (state) => {
      saved = structuredClone(state);
    },
    schedule: async () => {},
    current: async (request) => request,
    finished: async () => false,
    start: vi.fn(async () => {
      postEntered.resolve();
      return postResponse.promise;
    }),
  });

  const start = queue.run();
  await postEntered.promise;
  await queue.enqueue(next);
  postResponse.reject(new PreviewBuildRejected('test rejection'));
  await start;

  expect(saved).toEqual({ pending: next });
});

test('overlapping alarms do not start two builds', async () => {
  let saved: PreviewQueueState | undefined = { pending: first };
  const lookupEntered = Promise.withResolvers<void>();
  const lookupResponse = Promise.withResolvers<PreviewRequest>();
  const posts = vi.fn(async () => buildId);
  const queue = new PreviewBuildQueue({
    read: async () => structuredClone(saved),
    write: async (state) => {
      saved = structuredClone(state);
    },
    schedule: async () => {},
    current: async () => {
      lookupEntered.resolve();
      return lookupResponse.promise;
    },
    finished: async () => false,
    start: posts,
  });

  const firstAlarm = queue.run();
  await lookupEntered.promise;
  const secondAlarm = queue.run();
  lookupResponse.resolve(first);
  await Promise.all([firstAlarm, secondAlarm]);

  expect(posts).toHaveBeenCalledExactlyOnceWith(first);
});
