import { PREVIEW_REPOSITORY_ID } from '../src/server/preview-trigger/webhook.ts';

interface FixtureRequest {
  url?: string;
  headers: { host?: string };
}

interface FixtureResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}

const accountId = 'a'.repeat(32);
const workerTag = 'b'.repeat(32);
const triggerId = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e';
const buildTokenId = '84c98460-ff84-4ab5-a1ab-d453d8f7df46';
const github = 'api.github.com';
const cloudflare = 'api.cloudflare.com';
const prefix = `/client/v4/accounts/${accountId}/builds`;
const commands = {
  build_command: 'APP_VERSION=$(git rev-parse HEAD) && export APP_VERSION && pnpm build',
  deploy_command: 'node scripts/deploy-preview.ts',
  root_directory: '/',
  build_token_uuid: buildTokenId,
};

export const testBuildId = '023e105f-2f42-4f8b-a1c1-73f6a2a30c0f';
export const testAttemptedAt = 1_797_402_000_000;
export const testBindings = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_BUILD_TRIGGER_TOKEN: 'TEST_TOKEN',
  CLOUDFLARE_PREVIEW_WORKER_TAG: workerTag,
  CLOUDFLARE_PREVIEW_TRIGGER_ID: triggerId,
  CLOUDFLARE_PREVIEW_BUILD_TOKEN_ID: buildTokenId,
};

export function previewTriggerOutbound() {
  let pause = '';
  let posts = 0;
  let entered = Promise.withResolvers<void>();
  let released = Promise.withResolvers<void>();
  const repository = { id: PREVIEW_REPOSITORY_ID, full_name: 'banmen-dev/app' };
  const firstSha = 'a'.repeat(40);

  function reply(res: FixtureResponse, status: number, body?: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  return async (req: FixtureRequest, res: FixtureResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.hostname === 'preview-fixture.test') {
      switch (url.pathname) {
        case '/setup':
          released.resolve();
          pause = url.searchParams.get('pause') ?? '';
          posts = 0;
          entered = Promise.withResolvers<void>();
          released = Promise.withResolvers<void>();
          return reply(res, 204);
        case '/entered':
          await entered.promise;
          return reply(res, 204);
        case '/release':
          released.resolve();
          return reply(res, 204);
        case '/posts':
          return reply(res, 200, posts);
      }
    }

    async function waitAt(step: string) {
      if (pause !== step) return;
      entered.resolve();
      await released.promise;
    }

    const ok = (result: unknown) => reply(res, 200, { success: true, result });
    if (url.hostname === github && url.pathname === `/repositories/${PREVIEW_REPOSITORY_ID}/pulls/81`) {
      await waitAt('lookup');
      return reply(res, 200, {
        number: 81,
        state: 'open',
        head: { repo: repository, ref: '42-report', sha: firstSha },
        base: { repo: repository, ref: 'main' },
      });
    }
    if (url.hostname !== cloudflare) return reply(res, 404);
    switch (url.pathname) {
      case `${prefix}/workers/${workerTag}`:
        return ok({
          git_repository: {
            provider_type: 'github',
            repo_id: String(PREVIEW_REPOSITORY_ID),
            provider_account_name: 'banmen-dev',
            repo_name: 'app',
            branch: 'preview-builds-parked',
          },
          previews_enabled: false,
          production_settings: commands,
        });
      case `${prefix}/workers/${workerTag}/triggers`:
        return ok([
          {
            trigger_uuid: triggerId,
            external_script_id: workerTag,
            branch_includes: ['preview-builds-parked'],
            ...commands,
          },
        ]);
      case `${prefix}/triggers/${triggerId}/builds`:
        posts++;
        await waitAt('start');
        return pause === 'start' ? reply(res, 429, { success: false }) : ok({ build_uuid: testBuildId });
      case `${prefix}/builds/${testBuildId}`:
        await waitAt('recovery');
        return ok({
          build_uuid: testBuildId,
          status: 'running',
          created_on: new Date(testAttemptedAt).toISOString(),
          trigger: { trigger_uuid: triggerId, external_script_id: workerTag },
          build_trigger_metadata: { build_trigger_source: 'api', branch: '42-report', commit_hash: firstSha },
        });
      default:
        return reply(res, 404);
    }
  };
}
