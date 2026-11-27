import { beforeEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { feedbackSubmit } from '../src/shared/operations/feedback.ts';
import {
  fakeFeedbackGithubEnv,
  fakeFeedbackGithubResponse,
  FEEDBACK_ISSUES_URL,
  FEEDBACK_TOKEN_URL,
} from './feedback/fake-github-app.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const globalKey = 'feedback:global';
const input = {
  text: '画面についての感想です',
  route_id: '/',
  url: new URL('/', testEnv.PUBLIC_ORIGIN).href,
};

beforeEach(async () => {
  const db = commonDb(testEnv);
  await db.batch([db.statement((q) => q.deleteFrom('rate_limits').where('key', '=', globalKey))]);
  const { objects } = await testEnv.ATTACHMENTS.list({ prefix: 'feedback/' });
  if (objects.length > 0) await testEnv.ATTACHMENTS.delete(objects.map((object) => object.key));
});

function submit(
  app: ReturnType<typeof createApp>,
  person: Person,
  env: Env,
  body = input,
  executionCtx?: ExecutionContext,
) {
  return post(app, feedbackSubmit, { token: person.token, env, body, executionCtx });
}

function fakeResponse(request: Request): Response {
  const response = fakeFeedbackGithubResponse(request);
  if (response === undefined) throw new Error('想定外の送信先');
  return response;
}

test('残り1回の全体枠を異なるアカウントで同時に消費しても、起票は1回だけ', async () => {
  const people = await Promise.all(Array.from({ length: 4 }, () => createPerson()));
  const env = await fakeFeedbackGithubEnv(testEnv);
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('rate_limits').values({ key: globalKey, count: 59, window_start_at: new Date().toISOString() }),
    ),
  ]);

  const issues: Request[] = [];
  const app = createApp(undefined, {
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === FEEDBACK_ISSUES_URL) issues.push(request);
      return fakeResponse(request);
    },
  });
  const results = await Promise.all(people.map((person) => submit(app, person, env)));

  expect(results.map((response) => response.status).sort()).toEqual([200, 429, 429, 429]);
  expect(issues).toHaveLength(1);
});

test('同時に起票するリクエストにトークン取得を共有し、起点の waitUntil は起票の完了を待たない', async () => {
  const [first, second] = await Promise.all([createPerson(), createPerson()]);
  const env = await fakeFeedbackGithubEnv(testEnv);
  const db = commonDb(env);
  const tokenStarted = Promise.withResolvers<void>();
  const releaseToken = Promise.withResolvers<void>();
  const releaseIssues = Promise.withResolvers<void>();
  const firstWaited: Promise<unknown>[] = [];
  const secondWaited: Promise<unknown>[] = [];
  const context = (promises: Promise<unknown>[]) =>
    ({
      waitUntil: (promise: Promise<unknown>) => {
        promises.push(promise);
      },
    }) as ExecutionContext;

  let tokenRequests = 0;
  let issueRequests = 0;
  const app = createApp(undefined, {
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === FEEDBACK_TOKEN_URL) {
        tokenRequests++;
        tokenStarted.resolve();
        await releaseToken.promise;
      }
      if (request.url === FEEDBACK_ISSUES_URL) {
        issueRequests++;
        await releaseIssues.promise;
      }
      return fakeResponse(request);
    },
  });

  const firstResponse = submit(app, first, env, input, context(firstWaited));
  let secondResponse: Promise<Response> | undefined;
  try {
    await tokenStarted.promise;
    secondResponse = submit(app, second, env, input, context(secondWaited));
    await vi.waitFor(async () => {
      const row = await db.first(
        db.statement((q) => q.selectFrom('rate_limits').select('count').where('key', '=', globalKey)),
      );
      expect(row?.count).toBe(2);
    });
    expect(firstWaited).toHaveLength(1);
    expect(secondWaited).toHaveLength(0);
    releaseToken.resolve();
    const tokenWaited = vi.fn();
    const waited = firstWaited[0].then(tokenWaited);
    await vi.waitFor(() => {
      expect(tokenWaited).toHaveBeenCalledOnce();
      expect(issueRequests).toBe(2);
    });
    await waited;
  } finally {
    releaseToken.resolve();
    releaseIssues.resolve();
    await Promise.all([firstResponse, secondResponse]);
  }
  expect((await firstResponse).status).toBe(200);
  expect((await secondResponse)?.status).toBe(200);
  expect(tokenRequests).toBe(1);
});

test('本文の字数はサロゲートペアを1字と数え、上限の5,000字を通す', async () => {
  const [person, env] = await Promise.all([createPerson(), fakeFeedbackGithubEnv(testEnv)]);
  const app = createApp(undefined, { fetcher: async (input, init) => fakeResponse(new Request(input, init)) });

  const max = await submit(app, person, env, { ...input, text: '😀'.repeat(5_000) });
  expect(max.status).toBe(200);

  const tooLong = await submit(app, person, env, { ...input, text: '😀'.repeat(5_001) });
  expect(tooLong.status).toBe(400);
});

test('本文の上限を超えた送信は、起票せず 413 を返し、R2 にも置かない', async () => {
  const [person, env] = await Promise.all([createPerson(), fakeFeedbackGithubEnv(testEnv)]);
  const fetcher = vi.fn<typeof fetch>();
  const app = createApp(undefined, { fetcher });

  const response = await submit(app, person, env, { ...input, text: 'a'.repeat(14 * 1024 * 1024) });

  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  expect(fetcher).not.toHaveBeenCalled();
  expect((await env.ATTACHMENTS.list({ prefix: 'feedback/' })).objects).toHaveLength(0);
});

test('画面に出ない文字を大量に並べた文は、正規化の前に 400 で断る', async () => {
  const [person, env] = await Promise.all([createPerson(), fakeFeedbackGithubEnv(testEnv)]);
  const fetcher = vi.fn<typeof fetch>();
  const app = createApp(undefined, { fetcher });

  const response = await submit(app, person, env, { ...input, text: '\u200Bab'.repeat(27_000) });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  expect(fetcher).not.toHaveBeenCalled();
});
