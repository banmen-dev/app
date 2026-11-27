import { FEEDBACK_TEXT_MAX, feedbackSubmit } from '../../shared/operations/feedback.ts';
import { ROUTE_IDS } from '../../shared/route-ids.ts';
import { consumeRateLimit, FEEDBACK_GLOBAL_RATE_LIMIT, isRateLimitExceeded } from '../auth/rate-limit.ts';
import { ApiError } from '../errors.ts';
import {
  createFeedbackGithubClient,
  feedbackGithubCredentials,
  FeedbackIssueError,
  normalizeFeedbackText,
  type FeedbackGithubClient,
  type FeedbackGithubCredentials,
  type FeedbackIssueInput,
} from '../feedback/github-app.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';

const textPattern = new RegExp(`^.{1,${FEEDBACK_TEXT_MAX}}$`, 'su');

// Banmen と GitHub のトークンの接頭辞、秘密鍵の PEM ヘッダーを検出する。
const secretPattern = /(?:sgp_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|-----BEGIN\b/;

export type FeedbackTools = {
  readonly publicOrigin: string;
  createIssue(issue: FeedbackIssueInput): Promise<void>;
};

export async function checkFeedbackGlobalLimit(env: Env): Promise<void> {
  const { key, policy } = FEEDBACK_GLOBAL_RATE_LIMIT;
  if (await isRateLimitExceeded(env, key, policy, new Date())) throw new ApiError(429, 'rate_limited');
}

export function createFeedbackToolsFactory(fetcher: typeof fetch) {
  // 同じアプリへの連続したリクエストで有効なインストールトークンを再利用する。
  let cached: { credentials: FeedbackGithubCredentials; client: FeedbackGithubClient } | undefined;
  return (env: Env, waitUntil?: (promise: Promise<void>) => void): FeedbackTools => ({
    publicOrigin: env.PUBLIC_ORIGIN,
    async createIssue(issue) {
      const credentials = feedbackGithubCredentials(env);
      if (credentials === undefined) throw new ApiError(503, 'unavailable');

      const { key, policy } = FEEDBACK_GLOBAL_RATE_LIMIT;
      if (!(await consumeRateLimit(env, key, policy, new Date()))) throw new ApiError(429, 'rate_limited');

      if (
        cached === undefined ||
        cached.credentials.appId !== credentials.appId ||
        cached.credentials.installationId !== credentials.installationId ||
        cached.credentials.privateKeyPem !== credentials.privateKeyPem
      ) {
        const client = createFeedbackGithubClient(credentials, fetcher, { warn: (message) => console.warn(message) });
        cached = { credentials, client };
      }

      try {
        await cached.client.createFeedbackIssue(issue, waitUntil);
      } catch (err) {
        if (!(err instanceof FeedbackIssueError)) throw err;
        throw new ApiError(503, 'unavailable');
      }
    },
  });
}

function validateText(value: string): void {
  const text = normalizeFeedbackText(value);
  // 改行を含め、Unicode のコードポイントで長さを数える。
  if (!textPattern.test(text) || text.trim() === '') throw new ApiError(400, 'invalid_input');
  if (secretPattern.test(text)) {
    throw new ApiError(400, 'invalid_input', [{ path: 'text', code: 'custom', message: 'secret_detected' }]);
  }
}

function validateUrl(value: string, publicOrigin: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, 'invalid_input');
  }
  if (url.origin !== new URL(publicOrigin).origin || url.username !== '' || url.password !== '') {
    throw new ApiError(400, 'invalid_input');
  }
}

export const feedbackSubmitOperation = implement(feedbackSubmit, async ({ input, feedback }) => {
  validateText(input.text);
  validateUrl(input.url, feedback.publicOrigin);
  const submittedAt = new Date();
  const feedbackId = uuidv7(submittedAt);
  await feedback.createIssue({
    feedbackId,
    text: input.text,
    routeId: ROUTE_IDS.includes(input.route_id) ? input.route_id : null,
    submittedAt,
  });
  return { feedback_id: feedbackId };
});
