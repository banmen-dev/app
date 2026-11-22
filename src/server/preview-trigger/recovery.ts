import { previewBranchNumber } from '../../shared/preview-branch.ts';
import { timingSafeEqualStrings } from '../auth/tokens.ts';
import type { PreviewRecovery } from './queue.ts';
import { readPreviewBody } from './webhook.ts';

type PreviewRecoveryTarget = {
  status(): Promise<{ sha: string; attemptedAt: number } | null>;
  recover(recovery: PreviewRecovery): Promise<boolean>;
};

const buildIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function recoveryFromJson(value: unknown): PreviewRecovery | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { sha, attemptedAt, resolution, buildId } = value as Record<string, unknown>;
  if (
    typeof sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    typeof attemptedAt !== 'number' ||
    !Number.isSafeInteger(attemptedAt) ||
    attemptedAt <= 0
  ) {
    return undefined;
  }
  if (resolution === 'not-started' && buildId === undefined) return { sha, attemptedAt, resolution };
  if (resolution === 'attach' && typeof buildId === 'string' && buildIdPattern.test(buildId)) {
    return { sha, attemptedAt, resolution, buildId };
  }
  return undefined;
}

export async function handlePreviewRecovery(
  request: Request,
  secret: string | undefined,
  queueFor: (issue: string) => PreviewRecoveryTarget,
): Promise<Response> {
  const issue = /^\/operator\/preview-queues\/([1-9][0-9]*)$/.exec(new URL(request.url).pathname)?.[1];
  if (!issue || previewBranchNumber(`${issue}-operator`) !== issue) return new Response(null, { status: 404 });
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  }
  if (!secret) return new Response(null, { status: 503 });
  const authorization = request.headers.get('Authorization');
  if (!authorization || !timingSafeEqualStrings(authorization, `Bearer ${secret}`)) {
    return new Response(null, { status: 401 });
  }

  if (request.method === 'GET') {
    try {
      return Response.json({ attempt: await queueFor(issue).status() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return new Response(null, { status: 503 });
    }
  }

  const body = await readPreviewBody(request, 4096).catch(() => undefined);
  if (body === null) return new Response(null, { status: 413 });
  if (!body) return new Response(null, { status: 400 });
  let recovery: PreviewRecovery | undefined;
  try {
    recovery = recoveryFromJson(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!recovery) return new Response(null, { status: 400 });

  try {
    return new Response(null, { status: (await queueFor(issue).recover(recovery)) ? 204 : 409 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
