import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import type { PreviewQueueState } from '../src/server/preview-trigger/queue.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';
import type { PreviewBuildGate } from '../src/server/preview-trigger/worker.ts';
import { testAttemptedAt, testBuildId } from './preview-trigger-outbound.ts';

const first = { issue: '42', pr: 81, branch: '42-report', sha: 'a'.repeat(40) } satisfies PreviewRequest;
const next = { ...first, sha: 'b'.repeat(40) };
const { PREVIEW_BUILDS, PREVIEW_FIXTURE } = env as typeof env & {
  PREVIEW_BUILDS: DurableObjectNamespace<PreviewBuildGate>;
  PREVIEW_FIXTURE: Fetcher;
};

async function callFixture(path: string): Promise<Response> {
  const response = await PREVIEW_FIXTURE.fetch(`https://preview-fixture.test${path}`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Fixture failed (${response.status}): ${path}`);
  return response;
}

async function beforeResponse<T>(operation: Promise<T>): Promise<T | 'blocked'> {
  const deadline = Promise.withResolvers<'blocked'>();
  const timer = setTimeout(() => deadline.resolve('blocked'), 1000);
  try {
    return await Promise.race([operation, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function harness(step: 'lookup' | 'start' | 'recovery', initial?: PreviewQueueState) {
  await callFixture(`/setup?pause=${step}`);
  const gate = PREVIEW_BUILDS.getByName(crypto.randomUUID());
  const originalNow = Date.now;
  // 発火はテストが明示的に起こし、自動配信と競合させない。
  await runInDurableObject(gate, async (_instance, state) => {
    Date.now = () => +new Date() + 3_600_000;
    if (initial) await state.storage.put('queue', initial);
  });
  return {
    gate,
    alarm: () => runDurableObjectAlarm(gate),
    overlap: () => runInDurableObject(gate, (instance) => instance.alarm()),
    state: () => runInDurableObject(gate, (_instance, state) => state.storage.get<PreviewQueueState>('queue')),
    entered: () => callFixture('/entered'),
    posts: async () => (await callFixture('/posts')).json(),
    release: () => callFixture('/release'),
    finish: () =>
      runInDurableObject(gate, async (_instance, state) => {
        Date.now = originalNow;
        await state.storage.deleteAlarm();
      }),
  };
}

test('enqueue persists before an external head lookup returns', async () => {
  const h = await harness('lookup');
  await h.gate.enqueue(first);
  const alarm = h.alarm();
  let newer: Promise<void> | undefined;
  try {
    await h.entered();
    newer = h.gate.enqueue(next);
    expect(await beforeResponse(newer.then(() => 'enqueued'))).toBe('enqueued');
    expect((await h.state())?.pending).toEqual(next);
  } finally {
    await h.release();
    await Promise.allSettled([alarm, newer]);
    await h.finish();
  }
  expect(await alarm).toBe(true);
  expect((await h.state())?.pending).toEqual(next);
});

test('an outstanding start neither blocks enqueue nor permits recovery or another POST', async () => {
  const h = await harness('start');
  await h.gate.enqueue(first);
  const alarm = h.alarm();
  let newer: Promise<void> | undefined;
  let overlapping: Promise<void> | undefined;
  let recovery: Promise<boolean> | undefined;
  try {
    await h.entered();
    newer = h.gate.enqueue(next);
    overlapping = h.overlap();
    expect(await beforeResponse(newer.then(() => 'enqueued'))).toBe('enqueued');
    const active = (await h.state())?.active;
    expect(active?.attemptedAt).toBeTypeOf('number');
    recovery = h.gate.recover({
      sha: first.sha,
      attemptedAt: active?.attemptedAt ?? 0,
      resolution: 'not-started',
    });
    expect(await beforeResponse(recovery)).toBe(false);
    expect(await h.posts()).toBe(1);
    expect((await h.state())?.pending).toEqual(next);
  } finally {
    await h.release();
    await Promise.allSettled([alarm, newer, overlapping, recovery]);
    await h.finish();
  }
  expect(await alarm).toBe(true);
  await overlapping;
  expect(await h.posts()).toBe(1);
  const state = await h.state();
  expect(state).toMatchObject({ pending: next });
  expect(state?.active).toBeUndefined();
});

test('a delayed recovery lookup allows enqueue and cannot apply after the attempt is released', async () => {
  const h = await harness('recovery', { active: { request: first, id: null, attemptedAt: testAttemptedAt } });
  const recovery = { sha: first.sha, attemptedAt: testAttemptedAt };
  const attach = h.gate.recover({ ...recovery, resolution: 'attach', buildId: testBuildId });
  let newer: Promise<void> | undefined;
  let release: Promise<boolean> | undefined;
  try {
    await h.entered();
    newer = h.gate.enqueue(next);
    release = h.gate.recover({ ...recovery, resolution: 'not-started' });
    expect(await beforeResponse(newer.then(() => 'enqueued'))).toBe('enqueued');
    expect(await beforeResponse(release)).toBe(true);
    expect((await h.state())?.pending).toEqual(next);
  } finally {
    await h.release();
    await Promise.allSettled([attach, newer, release]);
    await h.finish();
  }
  expect(await attach).toBe(false);
  const state = await h.state();
  expect(state?.active).toBeUndefined();
  expect(state?.pending).toEqual(next);
});
