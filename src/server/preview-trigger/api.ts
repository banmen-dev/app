import { previewBranchNumber } from '../../shared/preview-branch.ts';
import { isIsolatedPreviewAccount } from '../../shared/preview-cloudflare.ts';
import { PreviewBuildRejected } from './queue.ts';
import { PREVIEW_REPOSITORY_ID, previewRequestFromPullRequest, type PreviewRequest } from './webhook.ts';

type PreviewApiConfig = {
  accountId: string;
  workerTag: string;
  triggerId: string;
  buildTokenId: string;
  token: string;
};

const accountIdPattern = /^[a-f0-9]{32}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const parkedBranch = 'preview-builds-parked';
const buildCommand = 'APP_VERSION=$(git rev-parse HEAD) && export APP_VERSION && pnpm build';
const deployCommand = 'node scripts/deploy-preview.ts';
const httpTimeoutMs = 5_000;
// 競合・タイムアウト・5xx は、Cloudflare が起動を受理した可能性がある。
const unacceptedBuildStatuses = new Set([400, 401, 403, 404, 422, 429]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('Preview API returned invalid JSON');
  }
}

export function createPreviewApi(config: PreviewApiConfig, fetcher: typeof fetch = fetch) {
  const { accountId, workerTag, triggerId, buildTokenId, token } = config;
  if (
    !isIsolatedPreviewAccount(accountId) ||
    !accountIdPattern.test(workerTag) ||
    !uuidPattern.test(triggerId) ||
    !uuidPattern.test(buildTokenId) ||
    !token
  ) {
    throw new Error('Invalid preview Builds configuration');
  }
  const buildsApi = `https://api.cloudflare.com/client/v4/accounts/${accountId.toLowerCase()}/builds`;
  const workerPath = `/workers/${workerTag}`;

  async function cloudflare(path: string, method: 'GET' | 'POST' = 'GET', body?: object): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetcher(buildsApi + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
    if (!response.ok) {
      const message = `Preview Builds API ${method} failed (${response.status})`;
      if (method === 'POST' && unacceptedBuildStatuses.has(response.status)) {
        const failure = record(await readJson(response).catch(() => undefined));
        if (failure?.success === false) throw new PreviewBuildRejected(message);
      }
      throw new Error(message);
    }
    const envelope = record(await readJson(response));
    if (envelope?.success !== true || envelope.result === undefined) {
      throw new Error(`Preview Builds API ${method} returned an invalid response`);
    }
    return envelope.result;
  }

  async function verifyTrigger() {
    const config = record(await cloudflare(workerPath));
    const repository = record(config?.git_repository);
    const settings = record(config?.production_settings);
    if (
      repository?.provider_type !== 'github' ||
      repository.repo_id !== String(PREVIEW_REPOSITORY_ID) ||
      repository.branch !== parkedBranch ||
      config?.previews_enabled !== false ||
      settings?.build_command !== buildCommand ||
      settings.deploy_command !== deployCommand ||
      settings.root_directory !== '/' ||
      settings.build_token_uuid !== buildTokenId
    ) {
      throw new Error('Preview Worker Builds settings do not match');
    }

    const triggers = await cloudflare(`${workerPath}/triggers`);
    const trigger = Array.isArray(triggers) && triggers.length === 1 ? record(triggers[0]) : undefined;
    const branches = trigger?.branch_includes;
    if (
      trigger?.trigger_uuid !== triggerId ||
      trigger.external_script_id !== workerTag ||
      trigger.build_command !== buildCommand ||
      trigger.deploy_command !== deployCommand ||
      trigger.root_directory !== '/' ||
      trigger.build_token_uuid !== buildTokenId ||
      !Array.isArray(branches) ||
      branches.length !== 1 ||
      branches[0] !== parkedBranch
    ) {
      throw new Error('Preview Worker Builds trigger does not match');
    }
  }

  return {
    async current(request: PreviewRequest): Promise<PreviewRequest | null> {
      if (!Number.isSafeInteger(request.pr) || request.pr <= 0) return null;
      const response = await fetcher(
        `https://api.github.com/repositories/${PREVIEW_REPOSITORY_ID}/pulls/${request.pr}`,
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Banmen-Preview-Trigger' },
          cache: 'no-store',
          redirect: 'manual',
          signal: AbortSignal.timeout(httpTimeoutMs),
        },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub PR lookup failed (${response.status})`);
      const pull = record(await readJson(response));
      const latest = previewRequestFromPullRequest(pull);
      if (!latest || latest.pr !== request.pr || latest.issue !== request.issue || latest.branch !== request.branch) {
        return null;
      }
      await verifyTrigger();
      const updatedAt = pull?.updated_at;
      // ラベルや題の更新でも updated_at は進む。同じ head に対する署名済みの再開は維持する。
      if (
        request.reopenedAt &&
        latest.sha === request.sha &&
        typeof updatedAt === 'string' &&
        updatedAt >= request.reopenedAt
      ) {
        return { ...latest, reopenedAt: request.reopenedAt };
      }
      return latest;
    },

    async start(request: PreviewRequest): Promise<string> {
      if (
        !request.issue ||
        previewBranchNumber(request.branch) !== request.issue ||
        !/^[a-f0-9]{40}$/.test(request.sha)
      ) {
        throw new Error('Invalid preview branch or commit');
      }
      const result = record(
        await cloudflare(`/triggers/${triggerId}/builds`, 'POST', {
          branch: request.branch,
          commit_hash: request.sha,
        }),
      );
      const id = result?.build_uuid;
      if (typeof id !== 'string' || !uuidPattern.test(id)) throw new Error('Preview build UUID is missing or invalid');
      return id;
    },

    async verifyRecovery(id: string, request: PreviewRequest, attemptedAt: number): Promise<boolean> {
      if (!uuidPattern.test(id)) return false;
      const result = record(await cloudflare(`/builds/${id}`));
      const metadata = record(result?.build_trigger_metadata);
      const trigger = record(result?.trigger);
      const createdAt = result?.created_on;
      return (
        result?.build_uuid === id &&
        trigger?.trigger_uuid === triggerId &&
        trigger.external_script_id === workerTag &&
        // Cloudflare は Builds API から起動したビルドを manual と記録することがある。
        (metadata?.build_trigger_source === 'api' || metadata?.build_trigger_source === 'manual') &&
        metadata.branch === request.branch &&
        metadata.commit_hash === request.sha &&
        typeof createdAt === 'string' &&
        Date.parse(createdAt) >= attemptedAt
      );
    },

    async finished(id: string): Promise<boolean> {
      if (!uuidPattern.test(id)) throw new Error('Invalid preview build UUID');
      const result = record(await cloudflare(`/builds/${id}`));
      if (result?.build_uuid !== id) throw new Error('Preview Builds returned a different build');
      switch (result.status) {
        case 'stopped':
          return true;
        case 'queued':
        case 'initializing':
        case 'running':
          return false;
        default:
          throw new Error('Unknown preview build status');
      }
    },
  };
}
