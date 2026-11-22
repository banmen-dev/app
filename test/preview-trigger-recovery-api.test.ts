import { describe, expect, it, vi } from 'vitest';
import { createPreviewApi } from '../src/server/preview-trigger/api.ts';
import { PreviewBuildRejected } from '../src/server/preview-trigger/queue.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const config = {
  accountId: 'a'.repeat(32),
  workerTag: 'b'.repeat(32),
  triggerId: '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e',
  buildTokenId: '84c98460-ff84-4ab5-a1ab-d453d8f7df46',
  token: 'preview-recovery-test-token',
};
const buildId = '49b20bde-4cd5-4e31-b4fa-17b5bfbaf90f';
const anotherId = 'c443c49f-1081-4389-877f-af62124357ff';
const request: PreviewRequest = { issue: '42', pr: 81, branch: '42-preview', sha: 'c'.repeat(40) };
const attemptedAt = Date.parse('2026-11-22T00:04:00.200Z');
const buildsUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/builds`;
const metadata = {
  build_trigger_source: 'api',
  branch: request.branch,
  commit_hash: request.sha,
};
const trigger = {
  trigger_uuid: config.triggerId,
  external_script_id: config.workerTag,
};
const matchingBuild = {
  build_uuid: buildId,
  created_on: '2026-11-22T00:04:00.300Z',
  build_trigger_metadata: metadata,
  trigger,
};

function api(respond: () => Response) {
  const fetcher = vi.fn<typeof fetch>(async () => respond());
  return { fetcher, api: createPreviewApi(config, fetcher) };
}

function cloudflareFailure(status: number) {
  return Response.json({ success: false, errors: [{ code: 12000 }] }, { status });
}

describe('Cloudflare Builds の起動 POST が受理されたか', () => {
  it.each([400, 401, 403, 404, 422, 429])('明示的な拒否の JSON を受けた HTTP %s は再試行できる', async (status) => {
    const { api: client } = api(() => cloudflareFailure(status));

    await expect(client.start(request)).rejects.toBeInstanceOf(PreviewBuildRejected);
  });

  const ambiguousResponses: [string, () => Response][] = [
    ['409 の競合', () => cloudflareFailure(409)],
    ['408 の応答待ち切れ', () => cloudflareFailure(408)],
    ['503 の障害', () => cloudflareFailure(503)],
    ['307 のリダイレクト', () => new Response(null, { status: 307, headers: { location: 'https://example.test/' } })],
    ['400 の JSON 不正', () => new Response('{"success":', { status: 400 })],
    ['429 の封筒不一致', () => Response.json({ success: true, result: { build_uuid: buildId } }, { status: 429 })],
    ['正常 HTTP の結果不足', () => Response.json({ success: true, result: {} })],
  ];

  it.each(ambiguousResponses)('%s では未受付を断定しない', async (_label, respond) => {
    const { api: client, fetcher } = api(respond);
    const outcome = await Promise.allSettled([client.start(request)]);

    expect(outcome[0].status).toBe('rejected');
    if (outcome[0].status === 'rejected') expect(outcome[0].reason).not.toBeInstanceOf(PreviewBuildRejected);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${buildsUrl}/triggers/${config.triggerId}/builds`,
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
  });

  it('ネットワーク切断では未受付を断定しない', async () => {
    const { api: client, fetcher } = api(() => {
      throw new Error('connection dropped');
    });

    await expect(client.start(request)).rejects.toThrow('connection dropped');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('保留中の試行と Build UUID の照合', () => {
  it('同じトリガー・Worker・ブランチ・SHAと時刻に合うビルドだけを採用する', async () => {
    const { api: client, fetcher } = api(() => Response.json({ success: true, result: matchingBuild }));

    await expect(client.verifyRecovery(buildId, request, attemptedAt)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${buildsUrl}/builds/${buildId}`,
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it.each([
    ['別の Build UUID', { build_uuid: anotherId }],
    ['別のトリガー', { trigger: { ...trigger, trigger_uuid: anotherId } }],
    ['別の Worker', { trigger: { ...trigger, external_script_id: 'c'.repeat(32) } }],
    ['別のブランチ', { build_trigger_metadata: { ...metadata, branch: '42-elsewhere' } }],
    ['別の SHA', { build_trigger_metadata: { ...metadata, commit_hash: 'd'.repeat(40) } }],
    ['手動で起動', { build_trigger_metadata: { ...metadata, build_trigger_source: 'manual' } }],
    ['試行の1ミリ秒前に起動', { created_on: '2026-11-22T00:04:00.199Z' }],
    ['時刻が壊れている', { created_on: 'invalid' }],
    ['トリガーが無い', { trigger: undefined }],
    ['メタデータが無い', { build_trigger_metadata: undefined }],
  ])('%sのビルドを復旧に使わない', async (_label, overrides) => {
    const { api: client } = api(() => Response.json({ success: true, result: { ...matchingBuild, ...overrides } }));

    await expect(client.verifyRecovery(buildId, request, attemptedAt)).resolves.toBe(false);
  });

  it('UUID の形が不正なら外部 API に問い合わせない', async () => {
    const { api: client, fetcher } = api(() => Response.json({ success: true, result: matchingBuild }));

    await expect(client.verifyRecovery('../different', request, attemptedAt)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
