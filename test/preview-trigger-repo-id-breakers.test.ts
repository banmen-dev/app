import { describe, expect, test, vi } from 'vitest';
import { createPreviewApi } from '../src/server/preview-trigger/api.ts';
import {
  handlePreviewWebhook,
  previewRequestFromPullRequest,
  PREVIEW_REPOSITORY_ID,
  type PreviewRequest,
} from '../src/server/preview-trigger/webhook.ts';

// リポジトリ ID だけの照合を崩す手口。既存のテストに無い型の揺れと宛先を確かめる。
const sha = '0123456789abcdef0123456789abcdef01234567';
const repo = { id: PREVIEW_REPOSITORY_ID };

function pull(headRepo: unknown = repo, baseRepo: unknown = repo) {
  return {
    number: 1380,
    state: 'open',
    base: { ref: 'main', repo: baseRepo },
    head: { ref: '1379-task-drawer-layout', sha, repo: headRepo },
  };
}

describe('ID の型の揺れ', () => {
  test.each([
    ['BigInt 風の文字列', '1425341812n'],
    ['前後に空白のある文字列', ' 1425341812 '],
    ['Number オブジェクト', new Number(PREVIEW_REPOSITORY_ID)],
    ['BigInt', BigInt(PREVIEW_REPOSITORY_ID)],
    ['負の ID', -PREVIEW_REPOSITORY_ID],
    ['近い浮動小数', PREVIEW_REPOSITORY_ID + 0.5],
    ['true', true],
  ])('head の id が %s なら起動対象にしない', (_label, id) => {
    expect(previewRequestFromPullRequest(pull({ id }))).toBeNull();
    expect(previewRequestFromPullRequest(pull(repo, { id }))).toBeNull();
  });

  test.each([
    ['配列', [repo]],
    ['undefined', undefined],
    ['数値そのもの', PREVIEW_REPOSITORY_ID],
    ['ID の文字列', String(PREVIEW_REPOSITORY_ID)],
  ])('head.repo が %s なら起動対象にしない', (_label, headRepo) => {
    const value = pull();
    value.head.repo = headRepo as typeof repo;
    expect(previewRequestFromPullRequest(value)).toBeNull();
  });

  test('JSON の 1425341812.0 は同じ数値なので受け付ける（JSON の数値表記の揺れで止めない）', async () => {
    const body = `{"action":"opened","number":1380,"repository":{"id":1425341812.0},"pull_request":${JSON.stringify(
      pull(),
    ).replaceAll('1425341812', '1425341812.0')}}`;
    const encoder = new TextEncoder();
    const secret = 'プレビューテスト専用の値';
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const signature = 'sha256=' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const enqueue = vi.fn<(build: PreviewRequest) => Promise<void>>(async () => {});
    const response = await handlePreviewWebhook(
      new Request('https://preview-trigger.example.test/github/webhook', {
        method: 'POST',
        headers: { 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': signature },
        body,
      }),
      secret,
      enqueue,
    );
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  test('id を持たず中に入れ子の id があるだけの repo は受け付けない', () => {
    expect(previewRequestFromPullRequest(pull({ owner: { id: PREVIEW_REPOSITORY_ID } }))).toBeNull();
  });
});

describe('Builds と GitHub の宛先', () => {
  const accountId = 'a'.repeat(32);
  const workerTag = 'b'.repeat(32);
  const triggerId = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e';
  const buildTokenId = '84c98460-ff84-4ab5-a1ab-d453d8f7df46';
  const request = { issue: '1379', pr: 1380, branch: '1379-task-drawer-layout', sha } satisfies PreviewRequest;
  const commands = {
    build_command: 'APP_VERSION=$(git rev-parse HEAD) && export APP_VERSION && pnpm build',
    deploy_command: 'node scripts/deploy-preview.ts',
    root_directory: '/',
    build_token_uuid: buildTokenId,
  };
  const workerUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/workers/${workerTag}`;
  const githubUrl = `https://api.github.com/repositories/${PREVIEW_REPOSITORY_ID}/pulls/1380`;

  function harness(gitRepository: Record<string, unknown>, github: () => Response = () => Response.json(pull())) {
    const sent: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const req = new Request(input, init);
      sent.push(req.url);
      if (req.url === githubUrl) return github();
      if (req.url === workerUrl) {
        return Response.json({
          success: true,
          result: { git_repository: gitRepository, previews_enabled: false, production_settings: commands },
        });
      }
      if (req.url === `${workerUrl}/triggers`) {
        return Response.json({
          success: true,
          result: [
            {
              trigger_uuid: triggerId,
              external_script_id: workerTag,
              branch_includes: ['preview-builds-parked'],
              ...commands,
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    return {
      api: createPreviewApi({ accountId, workerTag, triggerId, buildTokenId, token: 'TEST_TOKEN' }, fetcher),
      sent,
    };
  }

  const parked = { provider_type: 'github', repo_id: String(PREVIEW_REPOSITORY_ID), branch: 'preview-builds-parked' };

  test('git_repository に名前が一切無くても、provider_type と repo_id が合えば通す', async () => {
    const { api } = harness(parked);
    expect(await api.current(request)).toEqual(request);
  });

  test.each([
    ['前後に空白', ` ${PREVIEW_REPOSITORY_ID} `],
    ['先頭に 0', `0${PREVIEW_REPOSITORY_ID}`],
    ['小数表記', `${PREVIEW_REPOSITORY_ID}.0`],
    ['providerの大文字', undefined],
  ])('Builds の repo_id が %s なら起動しない', async (label, repoId) => {
    const gitRepository =
      label === 'providerの大文字' ? { ...parked, provider_type: 'GitHub' } : { ...parked, repo_id: repoId };
    const { api } = harness(gitRepository);
    await expect(api.current(request)).rejects.toThrow();
  });
});
