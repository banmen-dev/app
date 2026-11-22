import { previewBranchNumber } from '../../shared/preview-branch.ts';

// 組織の改名で止まらないよう、リポジトリは名前でなく ID だけで照合する。
// 掃除の scripts/deploy-preview.ts も Workers Builds の Node（型の除去）でこのファイルを直に読む。
// Worker 専用の import や、型の除去で消せない構文（enum など）を足さない。
export const PREVIEW_REPOSITORY_ID = 1425341812;

export type PreviewRequest = { issue: string; pr: number; branch: string; sha: string; reopenedAt?: string };

const BODY_LIMIT = 1024 * 1024;
const PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isPreviewRepository(value: unknown): boolean {
  const repo = record(value);
  return repo?.id === PREVIEW_REPOSITORY_ID;
}

export function previewRequestFromPullRequest(value: unknown): PreviewRequest | null {
  const pr = record(value);
  if (pr?.state !== 'open' || typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number < 1) {
    return null;
  }
  const base = record(pr.base);
  const head = record(pr.head);
  if (base?.ref !== 'main' || !isPreviewRepository(base.repo) || !isPreviewRepository(head?.repo)) return null;
  if (typeof head?.ref !== 'string' || typeof head.sha !== 'string' || !/^[0-9a-f]{40}$/.test(head.sha)) return null;
  const issue = previewBranchNumber(head.ref);
  return issue ? { issue, pr: pr.number, branch: head.ref, sha: head.sha } : null;
}

export async function readPreviewBody(request: Request, limit = BODY_LIMIT): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('content-length')) > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let body = new Uint8Array(Math.min(4096, limit));
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const end = bytes + value.byteLength;
      if (end > limit) {
        // 配信側がまだ送信中でも、残りの本文を待つ必要はない。
        void reader.cancel().catch(() => {});
        return null;
      }
      // チャンクごとの配列を持たず、小さなチャンクが続いても本文の上限に収める。
      if (end > body.byteLength) {
        const expanded = new Uint8Array(Math.min(limit, Math.max(end, body.byteLength * 2)));
        expanded.set(body);
        body = expanded;
      }
      body.set(value, bytes);
      bytes = end;
    }
  } finally {
    reader.releaseLock();
  }
  return body.subarray(0, bytes);
}

async function verifySignature(secret: string, signature: string, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const digest = new Uint8Array(32);
  for (let i = 0; i < digest.length; i += 1) {
    digest[i] = Number.parseInt(signature.slice(7 + i * 2, 9 + i * 2), 16);
  }
  return crypto.subtle.verify('HMAC', key, digest, body);
}

export async function handlePreviewWebhook(
  request: Request,
  secret: string | undefined,
  enqueue: (build: PreviewRequest) => Promise<void>,
): Promise<Response> {
  if (new URL(request.url).pathname !== '/github/webhook') return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (!secret) return new Response(null, { status: 503 });

  const signature = request.headers.get('x-hub-signature-256');
  if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return new Response(null, { status: 401 });
  const body = await readPreviewBody(request).catch(() => undefined);
  if (body === undefined) return new Response(null, { status: 400 });
  if (body === null) return new Response(null, { status: 413 });
  if (!(await verifySignature(secret, signature, body))) return new Response(null, { status: 401 });

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return new Response(null, { status: 400 });
  }
  const event = record(value);
  if (
    request.headers.get('x-github-event') !== 'pull_request' ||
    typeof event?.action !== 'string' ||
    !PR_ACTIONS.has(event.action) ||
    !isPreviewRepository(event.repository)
  ) {
    return new Response(null, { status: 204 });
  }
  const build = previewRequestFromPullRequest(event.pull_request);
  if (!build || build.pr !== event.number) return new Response(null, { status: 204 });
  if (event.action === 'reopened') {
    const updatedAt = record(event.pull_request)?.updated_at;
    if (typeof updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(updatedAt)) {
      const timestamp = Date.parse(updatedAt);
      if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().replace('.000Z', 'Z') === updatedAt) {
        build.reopenedAt = updatedAt;
      }
    }
  }

  try {
    await enqueue(build);
    return new Response(null, { status: 202 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
