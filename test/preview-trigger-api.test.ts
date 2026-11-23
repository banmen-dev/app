import { describe, expect, test, vi } from 'vitest';
import { createPreviewApi } from '../src/server/preview-trigger/api.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const accountId = 'a'.repeat(32);
const workerTag = 'b'.repeat(32);
const triggerId = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e';
const buildTokenId = '84c98460-ff84-4ab5-a1ab-d453d8f7df46';
const buildId = '023e105f-2f42-4f8b-a1c1-73f6a2a30c0f';
const config = { accountId, workerTag, triggerId, buildTokenId, token: 'TEST_TOKEN' };
const request = { issue: '42', pr: 81, branch: '42-report/section', sha: 'a'.repeat(40) } satisfies PreviewRequest;
const latest = { ...request, sha: 'b'.repeat(40) };
const repository = { id: 1425341812, full_name: 'banmen-dev/app' };
// Organization の改名を模した架空の名前。ID は同じリポジトリを指す。
const renamed = { id: 1425341812, full_name: 'renamed-guild/app' };
const githubPull = {
  number: request.pr,
  state: 'open',
  head: { repo: repository, ref: latest.branch, sha: latest.sha },
  base: { repo: repository, ref: 'main' },
};
const settings = {
  git_repository: {
    provider_type: 'github',
    repo_id: '1425341812',
    provider_account_name: 'banmen-dev',
    repo_name: 'app',
    branch: 'preview-builds-parked',
  },
  previews_enabled: false,
  production_settings: {
    build_command: 'APP_VERSION=$(git rev-parse HEAD) && export APP_VERSION && pnpm build',
    deploy_command: 'node scripts/deploy-preview.ts',
    root_directory: '/',
    build_token_uuid: buildTokenId,
  },
};
const trigger = {
  trigger_uuid: triggerId,
  external_script_id: workerTag,
  branch_includes: ['preview-builds-parked'],
  ...settings.production_settings,
};

const githubUrl = `https://api.github.com/repositories/1425341812/pulls/${request.pr}`;
const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds`;
const workerUrl = `${cfUrl}/workers/${workerTag}`;
const triggersUrl = `${workerUrl}/triggers`;
const startUrl = `${cfUrl}/triggers/${triggerId}/builds`;
const buildUrl = `${cfUrl}/builds/${buildId}`;

function success(result: unknown): Response {
  return Response.json({ success: true, result });
}

function harness(replacements: [url: string, respond: () => Response][] = []) {
  const handlers = new Map<string, () => Response>([
    [githubUrl, () => Response.json(githubPull)],
    [workerUrl, () => success(settings)],
    [triggersUrl, () => success([trigger])],
    [startUrl, () => success({ build_uuid: buildId })],
    [buildUrl, () => success({ build_uuid: buildId, status: 'stopped' })],
    ...replacements,
  ]);
  const sent: Request[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const req = new Request(input, init);
    sent.push(req);
    return handlers.get(req.url)?.() ?? new Response(null, { status: 404 });
  });
  return { api: createPreviewApi(config, fetcher), sent };
}

describe('Workers Builds の起動前の照合', () => {
  test('公開 GitHub の最新 head と停止用ブランチに固定した Cloudflare トリガーを照合する', async () => {
    const { api, sent } = harness();

    expect(await api.current(request)).toEqual(latest);
    expect(sent.map((req) => req.url).sort()).toEqual([githubUrl, workerUrl, triggersUrl].sort());
    for (const req of sent) {
      expect(req.method).toBe('GET');
      expect(req.redirect).toBe('manual');
      expect(req.headers.get('authorization')).toBe(req.url === githubUrl ? null : 'Bearer TEST_TOKEN');
    }
  });

  test.each([
    ['フォークの head', { ...githubPull, head: { ...githubPull.head, repo: { ...repository, id: 9 } } }],
    [
      '名前が同じで ID が異なる head',
      { ...githubPull, head: { ...githubPull.head, repo: { id: 9, full_name: repository.full_name } } },
    ],
    ['ID が文字列の head', { ...githubPull, head: { ...githubPull.head, repo: { ...repository, id: '1425341812' } } }],
    ['repo が null の head', { ...githubPull, head: { ...githubPull.head, repo: null } }],
    ['別リポジトリの base', { ...githubPull, base: { ...githubPull.base, repo: { ...repository, id: 9 } } }],
    [
      '名前が同じで ID が異なる base',
      { ...githubPull, base: { ...githubPull.base, repo: { id: 9, full_name: repository.full_name } } },
    ],
    ['ID が文字列の base', { ...githubPull, base: { ...githubPull.base, repo: { ...repository, id: '1425341812' } } }],
    ['main 以外の base', { ...githubPull, base: { ...githubPull.base, ref: 'production' } }],
    ['閉じた PR', { ...githubPull, state: 'closed' }],
    ['番号が異なる PR', { ...githubPull, number: request.pr + 1 }],
    ['別ブランチの head', { ...githubPull, head: { ...githubPull.head, ref: '42-other' } }],
    ['PR の取得で 404', null],
  ])('%s は起動対象から外す', async (_label, pull) => {
    const { api } = harness([
      [githubUrl, () => (pull === null ? new Response(null, { status: 404 }) : Response.json(pull))],
    ]);

    expect(await api.current(request)).toBeNull();
  });

  test.each([
    ['Cloudflare の repo ID が異なる', { ...settings, git_repository: { ...settings.git_repository, repo_id: '9' } }],
    [
      'Cloudflare の Git プロバイダーが異なる',
      { ...settings, git_repository: { ...settings.git_repository, provider_type: 'gitlab' } },
    ],
    [
      'Cloudflare の repo 名は同じで repo ID が異なる',
      { ...settings, git_repository: { ...settings.git_repository, repo_id: '1425341813' } },
    ],
    [
      'Cloudflare の repo ID が数値',
      { ...settings, git_repository: { ...settings.git_repository, repo_id: 1425341812 } },
    ],
    [
      'Cloudflare の repo ID が無い',
      { ...settings, git_repository: { ...settings.git_repository, repo_id: undefined } },
    ],
    ['停止用ブランチが変わっている', { ...settings, git_repository: { ...settings.git_repository, branch: 'main' } }],
    ['Cloudflare の自動プレビューが有効', { ...settings, previews_enabled: true }],
    [
      'ビルドコマンドが異なる',
      { ...settings, production_settings: { ...settings.production_settings, build_command: 'pnpm build' } },
    ],
    [
      'デプロイコマンドが異なる',
      { ...settings, production_settings: { ...settings.production_settings, deploy_command: 'wrangler deploy' } },
    ],
    [
      'ビルドのルートが異なる',
      { ...settings, production_settings: { ...settings.production_settings, root_directory: '/other' } },
    ],
  ])('%s 場合はエラーを返す', async (_label, changedSettings) => {
    const { api } = harness([[workerUrl, () => success(changedSettings)]]);

    await expect(api.current(request)).rejects.toThrow();
  });

  test.each([
    ['登録なし', []],
    ['許可した ID と異なる', [{ ...trigger, trigger_uuid: buildId }]],
    ['別 Worker のトリガー', [{ ...trigger, external_script_id: accountId }]],
    ['ワイルドカードを含む', [{ ...trigger, branch_includes: ['preview-builds-parked', '*'] }]],
    ['停止用以外のブランチ', [{ ...trigger, branch_includes: ['main'] }]],
    ['対象以外のトリガーもある', [trigger, { ...trigger, trigger_uuid: buildId }]],
  ])('Cloudflare トリガーが%s場合はエラーを返す', async (_label, triggers) => {
    const { api } = harness([[triggersUrl, () => success(triggers)]]);

    await expect(api.current(request)).rejects.toThrow();
  });

  test('GitHub の PR は名前の宛先でなく、リポジトリ ID の宛先で照会する', async () => {
    const { api, sent } = harness();

    await api.current(request);
    const github = sent.filter((req) => new URL(req.url).hostname === 'api.github.com').map((req) => req.url);
    expect(github).toEqual(['https://api.github.com/repositories/1425341812/pulls/81']);
    expect(github.some((url) => url.includes('/repos/'))).toBe(false);
  });

  test.each([
    ['head', { ...githubPull, head: { ...githubPull.head, repo: renamed } }],
    ['base', { ...githubPull, base: { ...githubPull.base, repo: renamed } }],
    [
      'head と base',
      { ...githubPull, head: { ...githubPull.head, repo: renamed }, base: { ...githubPull.base, repo: renamed } },
    ],
    [
      'full_name の無い head と base',
      {
        ...githubPull,
        head: { ...githubPull.head, repo: { id: 1425341812 } },
        base: { ...githubPull.base, repo: { id: 1425341812 } },
      },
    ],
  ])('GitHub の %s のリポジトリ名が改名後でも、ID が同じなら起動対象にする', async (_label, pull) => {
    const { api } = harness([[githubUrl, () => Response.json(pull)]]);

    expect(await api.current(request)).toEqual(latest);
  });

  test.each([
    ['所有者', { provider_account_name: 'renamed-guild' }],
    ['repo 名', { repo_name: 'renamed-app' }],
    ['所有者と repo 名', { provider_account_name: 'renamed-guild', repo_name: 'renamed-app' }],
  ])('Cloudflare の %s が改名後の名前でも、repo ID が同じなら照合を通す', async (_label, names) => {
    const { api } = harness([
      [workerUrl, () => success({ ...settings, git_repository: { ...settings.git_repository, ...names } })],
    ]);

    expect(await api.current(request)).toEqual(latest);
  });

  test('GitHub のリダイレクトは、有効な PR の JSON を添えていても受け付けない', async () => {
    const { api, sent } = harness([
      [githubUrl, () => Response.json(githubPull, { status: 302, headers: { location: 'https://example.test/' } })],
    ]);

    await expect(api.current(request)).rejects.toThrow();
    expect(sent.some((req) => req.url === 'https://example.test/')).toBe(false);
  });

  test('GitHub API の障害は、起動対象外として処理しない', async () => {
    const { api } = harness([[githubUrl, () => new Response(null, { status: 503 })]]);

    await expect(api.current(request)).rejects.toThrow();
  });
});

describe('Cloudflare Builds API', () => {
  test('起動するブランチと正確なコミットだけを、所定の Cloudflare トリガーへ渡す', async () => {
    const { api, sent } = harness();

    expect(await api.start(latest)).toBe(buildId);
    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req.url).toBe(startUrl);
    expect(req.method).toBe('POST');
    expect(req.redirect).toBe('manual');
    expect(req.headers.get('authorization')).toBe('Bearer TEST_TOKEN');
    expect(req.headers.get('content-type')).toMatch(/^application\/json\b/);
    expect(await req.json()).toEqual({ branch: latest.branch, commit_hash: latest.sha });
  });

  test.each([
    ['起動 UUID なし', () => success({})],
    ['起動 UUID が不正', () => success({ build_uuid: 'not-a-uuid' })],
    ['HTTP エラー', () => new Response(null, { status: 503 })],
    [
      'HTTP リダイレクト',
      () =>
        Response.json(
          { success: true, result: { build_uuid: buildId } },
          {
            status: 307,
            headers: { location: 'https://example.test/' },
          },
        ),
    ],
    ['Cloudflare のエラー応答', () => Response.json({ success: false, result: { build_uuid: buildId } })],
  ])('%sの場合は起動確認として扱わない', async (_label, response) => {
    const { api } = harness([[startUrl, response]]);

    await expect(api.start(latest)).rejects.toThrow();
  });

  test.each([
    ['queued', false],
    ['initializing', false],
    ['running', false],
    ['stopped', true],
  ])('ビルドの状態 %s を完了として扱うか判定する', async (status, expected) => {
    const { api, sent } = harness([[buildUrl, () => success({ build_uuid: buildId, status })]]);

    expect(await api.finished(buildId)).toBe(expected);
    expect(sent.map((req) => [req.url, req.method, req.redirect])).toEqual([[buildUrl, 'GET', 'manual']]);
    expect(sent[0].headers.get('authorization')).toBe('Bearer TEST_TOKEN');
  });

  test('不明な状態や通信の失敗は完了として扱わない', async () => {
    const unknown = harness([[buildUrl, () => success({ build_uuid: buildId, status: 'unknown' })]]);
    const unavailable = harness([[buildUrl, () => new Response(null, { status: 502 })]]);

    await expect(unknown.api.finished(buildId)).rejects.toThrow();
    await expect(unavailable.api.finished(buildId)).rejects.toThrow();
  });

  test.each([
    { ...config, accountId: '../account' },
    { ...config, workerTag: 'wrong-tag' },
    { ...config, triggerId: 'other/trigger' },
  ])('URL の構成に使えない ID を初期化時に拒否する', (badConfig) => {
    expect(() => createPreviewApi(badConfig)).toThrow();
  });
});
