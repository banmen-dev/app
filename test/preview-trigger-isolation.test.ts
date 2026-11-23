import { describe, expect, test, vi } from 'vitest';
import { createPreviewApi } from '../src/server/preview-trigger/api.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const productionAccountId = '71293a3c23974c311b4c82b3f977049b';
const accountId = 'a'.repeat(32);
const workerTag = 'b'.repeat(32);
const triggerId = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e';
const buildTokenId = '023e105f-2f42-4f8b-a1c1-73f6a2a30c0f';
const foreignBuildTokenId = '49b20bde-4cd5-4e31-b4fa-17b5bfbaf90f';
const config = { accountId, workerTag, triggerId, buildTokenId, token: 'TEST_TOKEN' };
const build = { issue: '42', pr: 81, branch: '42-report', sha: 'a'.repeat(40) } satisfies PreviewRequest;
const repository = { id: 1425341812, full_name: 'banmen-dev/app' };
const githubPull = {
  number: build.pr,
  state: 'open',
  head: { repo: repository, ref: build.branch, sha: build.sha },
  base: { repo: repository, ref: 'main' },
};
const githubUrl = `https://api.github.com/repositories/1425341812/pulls/${build.pr}`;
const workerUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/workers/${workerTag}`;

function harness(settingsToken: string | undefined, triggerToken: string | undefined) {
  const commands = {
    build_command: 'APP_VERSION=$(git rev-parse HEAD) && export APP_VERSION && pnpm build',
    deploy_command: 'node scripts/deploy-preview.ts',
    root_directory: '/',
  };
  const responses = new Map<string, unknown>([
    [githubUrl, githubPull],
    [
      workerUrl,
      {
        success: true,
        result: {
          git_repository: {
            provider_type: 'github',
            repo_id: '1425341812',
            provider_account_name: 'banmen-dev',
            repo_name: 'app',
            branch: 'preview-builds-parked',
          },
          previews_enabled: false,
          production_settings: { ...commands, build_token_uuid: settingsToken },
        },
      },
    ],
    [
      workerUrl + '/triggers',
      {
        success: true,
        result: [
          {
            ...commands,
            build_token_uuid: triggerToken,
            trigger_uuid: triggerId,
            external_script_id: workerTag,
            branch_includes: ['preview-builds-parked'],
          },
        ],
      },
    ],
  ]);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const { url } = new Request(input, init);
    if (!responses.has(url)) throw new Error('Unexpected request');
    return Response.json(responses.get(url));
  });
  return { api: createPreviewApi(config, fetcher), fetcher };
}

describe('プレビュー用 Cloudflare アカウントと Builds トークンの分離', () => {
  test('本番アカウントでは API を初期化せず通信もしない', () => {
    const fetcher = vi.fn<typeof fetch>();

    expect(() => createPreviewApi({ ...config, accountId: productionAccountId }, fetcher)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('プレビュー専用トークンの ID が設定とトリガーの両方にあれば起動前照合を通す', async () => {
    const { api, fetcher } = harness(buildTokenId, buildTokenId);

    await expect(api.current(build)).resolves.toEqual(build);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test.each([
    ['設定側に別のトークン', foreignBuildTokenId, buildTokenId],
    ['トリガー側に別のトークン', buildTokenId, foreignBuildTokenId],
    ['両方に同じ別トークン', foreignBuildTokenId, foreignBuildTokenId],
    ['設定側にトークンなし', undefined, buildTokenId],
    ['トリガー側にトークンなし', buildTokenId, undefined],
  ])('%s がある場合は起動前照合を拒否する', async (_label, settingsToken, triggerToken) => {
    const { api } = harness(settingsToken, triggerToken);

    await expect(api.current(build)).rejects.toThrow();
  });
});
