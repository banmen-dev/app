import { beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { feedbackSubmit } from '../src/shared/operations/feedback.ts';
import { fakeFeedbackGithubEnv, fakeFeedbackGithubResponse, FEEDBACK_ISSUES_URL } from './feedback/fake-github-app.ts';
import { post } from './operations/harness.ts';
import { createPerson, testEnv, type Person } from './operations/world.ts';

const GLOBAL_KEY = 'feedback:global';
const HOUR = 60 * 60 * 1000;
const ISSUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOARD_ROUTE_ID = '/[slug]/w/[id]/board';
const BOARD_PATH = '/test-private-org/w/test-private-workspace/board';
const input = {
  text: '画面の見出しが切れています',
  route_id: BOARD_ROUTE_ID,
  url: new URL(`${BOARD_PATH}?source=private-query#private-fragment`, testEnv.PUBLIC_ORIGIN).href,
};

let githubEnv: Env;
const unconfiguredEnv = {
  ...testEnv,
  FEEDBACK_GITHUB_APP_ID: undefined,
  FEEDBACK_GITHUB_INSTALLATION_ID: undefined,
  FEEDBACK_GITHUB_PRIVATE_KEY: undefined,
} as unknown as Env;

beforeAll(async () => {
  githubEnv = await fakeFeedbackGithubEnv(testEnv);
});

const accountKey = (accountId: string) => `operation:feedback-submit:${accountId}`;

async function count(key: string): Promise<number | undefined> {
  const db = commonDb(testEnv);
  const row = await db.first(db.statement((q) => q.selectFrom('rate_limits').select('count').where('key', '=', key)));
  return row?.count;
}

async function setCounter(key: string, count: number, startedAt = Date.now()) {
  const db = commonDb(testEnv);
  const values = { window_start_at: new Date(startedAt).toISOString(), count };
  await db.run(
    db.statement((q) =>
      q
        .insertInto('rate_limits')
        .values({ key, ...values })
        .onConflict((conflict) => conflict.column('key').doUpdateSet(values)),
    ),
  );
}

beforeEach(async () => {
  const db = commonDb(testEnv);
  await db.run(db.statement((q) => q.deleteFrom('rate_limits').where('key', '=', GLOBAL_KEY)));
});

type GithubIssue = { title: string; body: string; labels: string[] };

function fakeGithub(issueResponse?: () => Response) {
  const requests: Request[] = [];
  const issues: GithubIssue[] = [];
  const fetcher: typeof fetch = async (requestInput, init) => {
    const request = new Request(requestInput, init);
    requests.push(request);
    if (request.url === FEEDBACK_ISSUES_URL && request.method === 'POST') {
      issues.push(await request.json());
      if (issueResponse) return issueResponse();
    }
    const response = fakeFeedbackGithubResponse(request);
    if (response) return response;
    throw new Error('想定外のフィードバックの送信先');
  };
  const app = createApp(undefined, { fetcher });
  return { app, issues, requests };
}

function submit(app: ReturnType<typeof createApp>, person?: Person, body: unknown = input, env: Env = githubEnv) {
  return post(app, feedbackSubmit, { env, token: person?.token, body });
}

async function expectError(res: Response, status: number, code: string, details?: unknown) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({
    error: { code, message: code.replaceAll('_', ' '), ...(details === undefined ? {} : { details }) },
  });
}

test('ログインしていない人には 401 を返し、全体の枠を数えず GitHub にも送らない', async () => {
  const { app, requests } = fakeGithub();

  await expectError(await submit(app), 401, 'unauthenticated');

  expect(requests).toHaveLength(0);
  expect(await count(GLOBAL_KEY)).toBeUndefined();
});

test('組織に属さないログイン済みの人が送ると、既知の route ID と送信ごとの ID を Issue に載せる', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();
  const submittedText = '見出しが切れています\r\n```\r\n@someone https://example.test';

  const res = await submit(app, person, { ...input, text: submittedText });
  expect(res.status).toBe(200);
  const output = await res.json<{ feedback_id: string }>();
  expect(output).toEqual({ feedback_id: expect.stringMatching(ISSUE_ID_PATTERN) });
  expect(issues).toHaveLength(1);
  expect(issues[0].labels).toEqual(['feedback']);
  expect(issues[0].title).toMatch(/^フィードバック /);
  expect(issues[0].body).toContain('````text\n見出しが切れています\n```\n@someone https://example.test\n````');
  expect(issues[0].body).toContain(BOARD_ROUTE_ID);
  expect(issues[0].body).toContain(output.feedback_id);
  for (const privateValue of [BOARD_PATH, input.url, 'private-query', 'private-fragment', person.accountId]) {
    expect(issues[0].body).not.toContain(privateValue);
  }

  const second = await submit(app, person);
  expect(second.status).toBe(200);
  const secondOutput = await second.json<{ feedback_id: string }>();
  expect(secondOutput.feedback_id).toMatch(ISSUE_ID_PATTERN);
  expect(secondOutput.feedback_id).not.toBe(output.feedback_id);
});

test('実際のページのパスが route ID に入っても公開しない', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();

  const res = await submit(app, person, { ...input, route_id: BOARD_PATH });

  expect(res.status).toBe(200);
  expect(issues).toHaveLength(1);
  expect(issues[0].body).not.toContain(BOARD_PATH);
});

test('route ID の形が不正な入力を断る', async () => {
  const person = await createPerson();
  const { app, requests } = fakeGithub();

  for (const route_id of ['relative/path', '/with space', '/#fragment', '/```\n本文']) {
    const res = await submit(app, person, { ...input, route_id });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input', message: 'invalid input' } });
  }
  expect(requests).toHaveLength(0);
  expect(await count(GLOBAL_KEY)).toBeUndefined();
});

test('空、正規化で空になる本文、5,001字の本文を断り、正規化後の1字と5,000字は通す', async () => {
  const person = await createPerson();
  const { app, requests, issues } = fakeGithub();

  for (const text of ['', '\u200B\u2060\u0000', 'あ'.repeat(5_001)]) {
    const res = await submit(app, person, { ...input, text });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input', message: 'invalid input' } });
  }
  expect(requests).toHaveLength(0);
  expect(await count(GLOBAL_KEY)).toBeUndefined();

  for (const text of ['あ', 'あ'.repeat(5_000)]) {
    const res = await submit(app, person, { ...input, text: `\u200B${text}\u2060` });
    expect(res.status).toBe(200);
    expect(issues.at(-1)?.body).toContain(text);
  }
  expect(issues).toHaveLength(2);
  expect(await count(GLOBAL_KEY)).toBe(2);
});

test('既知の秘密の形や正規化で秘密の形になる文は内容を返さずに断る', async () => {
  const person = await createPerson();
  const { app, requests } = fakeGithub();
  const markers = [
    `bnp_${'a'.repeat(43)}`,
    `sgp_${'a'.repeat(43)}`,
    `ghp_${'a'.repeat(36)}`,
    `git\u200Bhub_pat_${'a'.repeat(82)}`,
    '-----BEGIN PRIVATE KEY-----',
  ];

  for (const marker of markers) {
    const res = await submit(app, person, { ...input, text: `貼ってしまった値 ${marker}` });
    await expectError(res, 400, 'invalid_input', [{ path: 'text', code: 'custom', message: 'secret_detected' }]);
  }
  expect(requests).toHaveLength(0);
  expect(await count(GLOBAL_KEY)).toBeUndefined();
});

test('同一オリジンの絶対 HTTP(S) URL だけを受ける', async () => {
  const person = await createPerson();
  const { app, requests } = fakeGithub();

  for (const url of ['https://another.example.test/path', BOARD_PATH, 'file:///tmp/test.txt']) {
    const res = await submit(app, person, { ...input, url });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input', message: 'invalid input' } });
  }
  expect(requests).toHaveLength(0);
  expect(await count(GLOBAL_KEY)).toBeUndefined();
});

test('GitHub App のシークレットが無い環境では通信せず 503 を返す', async () => {
  const person = await createPerson();
  const { app, requests } = fakeGithub();

  await expectError(await submit(app, person, input, unconfiguredEnv), 503, 'unavailable');

  expect(requests).toHaveLength(0);
});

test.each([
  [
    'GitHub に届かない',
    () => {
      throw new TypeError('通信先の内部情報');
    },
  ],
  ['GitHub が 500 を返す', () => Response.json({ message: '公開しない GitHub の応答' }, { status: 500 })],
] as const)('%sときに 503 を返し、全体の枠を戻さない', async (_label, issueResponse) => {
  const person = await createPerson();
  const { app, issues } = fakeGithub(issueResponse);

  await expectError(await submit(app, person), 503, 'unavailable');

  expect(issues).toHaveLength(1);
  expect(await count(GLOBAL_KEY)).toBe(1);
});

test('同じアカウントは1時間の10回目を通し、11回目は全体の枠を使わずに断る', async () => {
  const person = await createPerson();
  const { app, issues } = fakeGithub();
  const key = accountKey(person.accountId);
  await setCounter(key, 9);

  expect((await submit(app, person)).status).toBe(200);
  await expectError(await submit(app, person), 429, 'rate_limited');

  expect(issues).toHaveLength(1);
  expect(await count(key)).toBe(11);
  expect(await count(GLOBAL_KEY)).toBe(1);

  await setCounter(key, 10, Date.now() - HOUR);
  expect((await submit(app, person)).status).toBe(200);
  expect(await count(key)).toBe(1);
});

test('全体で60回目を通し、上限に届くと他の人からの要求も入力を読む前に断る', async () => {
  const [person, other] = await Promise.all([createPerson(), createPerson()]);
  const { app, issues } = fakeGithub();
  await setCounter(GLOBAL_KEY, 59);

  expect((await submit(app, person)).status).toBe(200);
  const blocked = await post(app, feedbackSubmit, { env: githubEnv, token: other.token, rawBody: '{' });
  await expectError(blocked, 429, 'rate_limited');

  expect(issues).toHaveLength(1);
  expect(await count(GLOBAL_KEY)).toBe(60);
  expect(await count(accountKey(other.accountId))).toBeUndefined();

  await setCounter(GLOBAL_KEY, 60, Date.now() - HOUR);
  expect((await submit(app, other)).status).toBe(200);
  expect(await count(GLOBAL_KEY)).toBe(1);
});
