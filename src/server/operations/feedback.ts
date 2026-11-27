import { FEEDBACK_TEXT_MAX, feedbackSubmit } from '../../shared/operations/feedback.ts';
import { ROUTE_IDS } from '../../shared/route-ids.ts';
import { consumeRateLimit, FEEDBACK_GLOBAL_RATE_LIMIT, isRateLimitExceeded } from '../auth/rate-limit.ts';
import { ApiError } from '../errors.ts';
import {
  createFeedbackGithubClient,
  feedbackGithubCredentials,
  feedbackViewerUrl,
  FeedbackIssueError,
  normalizeFeedbackText,
  type FeedbackGithubClient,
  type FeedbackGithubCredentials,
  type FeedbackIssueInput,
} from '../feedback/github-app.ts';
import {
  feedbackObjectKeys,
  putFeedbackObjects,
  readFeedbackImages,
  removeFeedbackObjects,
} from '../feedback/store.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';

const textPattern = new RegExp(`^.{1,${FEEDBACK_TEXT_MAX}}$`, 'su');

// Banmen と GitHub のトークンの接頭辞、秘密鍵の PEM ヘッダーを検出する。
const secretPattern = /(?:sgp_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|-----BEGIN\b/;

export type FeedbackTools = {
  readonly publicOrigin: string;
  readonly bucket: Pick<R2Bucket, 'put' | 'delete'>;
  // Issue を立てる前の確かめ。GitHub App の設定が無ければ 503、全体の枠が上限なら 429（どちらも Issue は立っていない）。
  // 通れば全体の枠を1つ数える
  reserve(): Promise<void>;
  // Issue を立てる。失敗は FeedbackIssueError（立っていないか、立ったかもしれないかを failure で見分ける）
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
    bucket: env.ATTACHMENTS,
    async reserve() {
      if (feedbackGithubCredentials(env) === undefined) throw new ApiError(503, 'unavailable');
      const { key, policy } = FEEDBACK_GLOBAL_RATE_LIMIT;
      if (!(await consumeRateLimit(env, key, policy, new Date()))) throw new ApiError(429, 'rate_limited');
    },
    async createIssue(issue) {
      const credentials = feedbackGithubCredentials(env);
      if (credentials === undefined)
        throw new FeedbackIssueError('not_created', 'フィードバックの GitHub App の設定が無い');

      if (
        cached === undefined ||
        cached.credentials.appId !== credentials.appId ||
        cached.credentials.installationId !== credentials.installationId ||
        cached.credentials.privateKeyPem !== credentials.privateKeyPem
      ) {
        const client = createFeedbackGithubClient(credentials, fetcher, { warn: (message) => console.warn(message) });
        cached = { credentials, client };
      }

      await cached.client.createFeedbackIssue(issue, waitUntil);
    },
  });
}

// 正規化の前に、極端に長い文を断る（画面に出ない文字を大量に並べた文で、正規化の時間を使わせない）。
// 5,000字を JSON の Unicode エスケープで送った分より大きい
const RAW_TEXT_MAX = 64 * 1024;

function validateText(value: string): void {
  if (value.length > RAW_TEXT_MAX) throw new ApiError(400, 'invalid_input');
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

// 保管する URL: オリジンとパスだけ（クエリとフラグメントは捨てる）。招待（/invite）と認証（/auth/）の画面は、
// 招待の秘密を運用者が持たないよう残さない
function storedUrl(value: string): string | null {
  const url = new URL(value);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // 復号できない経路は、招待や認証の画面かを見分けられないので、残さない
    return null;
  }
  // 最初の区間だけを見る（組織の slug が invitecorp の画面は残す）
  const first = path
    .toLowerCase()
    .split('/')
    .find((segment) => segment !== '');
  if (first === 'invite' || first === 'auth') return null;
  return `${url.origin}${url.pathname}`;
}

// 書く順: 入力と画像を確かめる → 全体の枠を数える → ID を作る → 画像と meta.json を R2 に置く → Issue を立てる。
// 起票されていないと分かる失敗では置いた R2 を消し、起票されたかもしれない失敗では残す（運用者が辿れるように）
export const feedbackSubmitOperation = implement(feedbackSubmit, async ({ input, multipart, accountId, feedback }) => {
  validateText(input.text);
  validateUrl(input.url, feedback.publicOrigin);
  const submittedAt = new Date();
  const images = await readFeedbackImages(multipart.files, submittedAt);
  await feedback.reserve();

  const feedbackId = uuidv7(submittedAt);
  const text = normalizeFeedbackText(input.text);
  const routeId = ROUTE_IDS.includes(input.route_id) ? input.route_id : null;
  const keys = feedbackObjectKeys(feedbackId, images);
  const stored = await putFeedbackObjects(
    feedback.bucket,
    { feedbackId, accountId, url: storedUrl(input.url), routeId, text, submittedAt },
    images,
  );
  if (!stored) {
    await removeFeedbackObjects(feedback.bucket, keys);
    throw new ApiError(503, 'unavailable');
  }

  const viewerUrl = feedbackViewerUrl(feedback.publicOrigin, feedbackId);
  // 閲覧の口が載らないと運用者が画像に辿れない。公開の URL の設定を見直せるよう、固定の文で知らせる
  if (viewerUrl === null) console.warn('フィードバックの閲覧の口の URL を作れなかった（PUBLIC_ORIGIN の形）');
  try {
    await feedback.createIssue({ feedbackId, text: input.text, routeId, viewerUrl, submittedAt });
  } catch (err) {
    if (!(err instanceof FeedbackIssueError)) throw err;
    if (err.failure === 'not_created') await removeFeedbackObjects(feedback.bucket, keys);
    throw new ApiError(503, 'unavailable');
  }
  return { feedback_id: feedbackId };
});
