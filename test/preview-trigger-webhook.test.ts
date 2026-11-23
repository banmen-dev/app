import { describe, expect, it, vi } from 'vitest';
import {
  handlePreviewWebhook,
  previewRequestFromPullRequest,
  PREVIEW_REPOSITORY_ID,
  type PreviewRequest,
} from '../src/server/preview-trigger/webhook.ts';

const webhookUrl = 'https://preview-trigger.example.test/github/webhook';
const secret = 'プレビューテスト専用の値';
const repo = { id: 1425341812, full_name: 'banmen-dev/app' };
// Organization の改名を模した架空の名前。ID は同じリポジトリを指す。
const renamed = { id: 1425341812, full_name: 'renamed-guild/app' };
const sha = '0123456789abcdef0123456789abcdef01234567';
const encoder = new TextEncoder();

function eligible() {
  return {
    action: 'opened',
    number: 1380,
    repository: { ...repo },
    pull_request: {
      number: 1380,
      state: 'open',
      title: 'モバイルの表示を直す',
      base: { ref: 'main', repo: { ...repo } },
      head: { ref: '1379-task-drawer-layout', sha, repo: { ...repo } },
    },
  };
}

async function sign(body: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return 'sha256=' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function request(body: string, event = 'pull_request', signedBody = body) {
  return new Request(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': await sign(signedBody),
    },
    body,
  });
}

function queue() {
  return vi.fn<(build: PreviewRequest) => Promise<void>>(async () => {});
}

describe('プレビューの GitHub Webhook', () => {
  it.each(['opened', 'reopened', 'synchronize'])(
    '%s は同じリポジトリの番号付き PR のビルドを受け付ける',
    async (action) => {
      const payload = eligible();
      payload.action = action;
      // 再シリアライズした JSON と署名対象が異なるよう、改行と空白を含む UTF-8 で送る。
      const body = JSON.stringify(payload, null, 2) + '\n';
      const enqueue = queue();
      const response = await handlePreviewWebhook(await request(body), secret, enqueue);

      expect(response.status).toBe(202);
      expect(enqueue).toHaveBeenCalledExactlyOnceWith({
        issue: '1379',
        pr: 1380,
        branch: '1379-task-drawer-layout',
        sha,
      });
    },
  );

  it('同じ Issue 番号の有効な枝名でスラッシュを使える', async () => {
    const payload = eligible();
    payload.pull_request.head.ref = '1379-task/sub_branch';
    const enqueue = queue();
    const response = await handlePreviewWebhook(await request(JSON.stringify(payload)), secret, enqueue);
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({ issue: '1379', pr: 1380, branch: '1379-task/sub_branch', sha });
  });

  it.each([
    ['配信元', (payload: ReturnType<typeof eligible>) => void (payload.repository = { ...renamed })],
    ['base', (payload: ReturnType<typeof eligible>) => void (payload.pull_request.base.repo = { ...renamed })],
    ['head', (payload: ReturnType<typeof eligible>) => void (payload.pull_request.head.repo = { ...renamed })],
    [
      '配信元・base・head のすべて',
      (payload: ReturnType<typeof eligible>) => {
        payload.repository = { ...renamed };
        payload.pull_request.base.repo = { ...renamed };
        payload.pull_request.head.repo = { ...renamed };
      },
    ],
  ])('%s のリポジトリ名が改名後の名前でも、ID が同じなら起動する', async (_label, rename) => {
    const payload = eligible();
    rename(payload);
    const enqueue = queue();
    const response = await handlePreviewWebhook(await request(JSON.stringify(payload)), secret, enqueue);

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({
      issue: '1379',
      pr: 1380,
      branch: '1379-task-drawer-layout',
      sha,
    });
  });

  it('リポジトリに full_name が無くても、ID が同じなら起動する', async () => {
    const payload = eligible();
    const idOnly = { id: PREVIEW_REPOSITORY_ID } as typeof repo;
    payload.repository = idOnly;
    payload.pull_request.base.repo = idOnly;
    payload.pull_request.head.repo = idOnly;
    const enqueue = queue();
    const response = await handlePreviewWebhook(await request(JSON.stringify(payload)), secret, enqueue);

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('PR の照合は名前でなく ID で行う', () => {
    const pull = eligible().pull_request;
    const renamedPull = { ...pull, base: { ...pull.base, repo: renamed }, head: { ...pull.head, repo: renamed } };
    expect(previewRequestFromPullRequest(renamedPull)).toEqual({
      issue: '1379',
      pr: 1380,
      branch: '1379-task-drawer-layout',
      sha,
    });
    expect(
      previewRequestFromPullRequest({
        ...pull,
        head: { ...pull.head, repo: { ...repo, id: PREVIEW_REPOSITORY_ID + 1 } },
      }),
    ).toBeNull();
    expect(
      previewRequestFromPullRequest({
        ...pull,
        base: { ...pull.base, repo: { ...repo, id: String(PREVIEW_REPOSITORY_ID) } },
      }),
    ).toBeNull();
  });

  it('受信ボディを1文字だけ変更すると、署名の検証で拒否する', async () => {
    const body = JSON.stringify(eligible());
    const enqueue = queue();
    const response = await handlePreviewWebhook(await request(body + ' ', 'pull_request', body), secret, enqueue);
    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([null, 'sha1=00', 'sha256=00', 'sha256=' + 'g'.repeat(64)])(
    '署名が無い、または形式が不正なときは拒否する (%s)',
    async (signature) => {
      const incoming = await request(JSON.stringify(eligible()));
      if (signature === null) incoming.headers.delete('X-Hub-Signature-256');
      else incoming.headers.set('X-Hub-Signature-256', signature);
      const enqueue = queue();
      expect((await handlePreviewWebhook(incoming, secret, enqueue)).status).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, ''])('Webhook の秘密が未設定なときは起動しない (%s)', async (configuredSecret) => {
    const enqueue = queue();
    const response = await handlePreviewWebhook(await request(JSON.stringify(eligible())), configuredSecret, enqueue);
    expect(response.status).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('署名が有効でも不正な JSON は 400 を返す', async () => {
    const enqueue = queue();
    expect((await handlePreviewWebhook(await request('{"action":'), secret, enqueue)).status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('Webhook の URL と HTTP メソッドを制限する', async () => {
    const enqueue = queue();
    expect((await handlePreviewWebhook(new Request(webhookUrl), secret, enqueue)).status).toBe(405);
    expect(
      (
        await handlePreviewWebhook(
          new Request('https://preview-trigger.example.test/', { method: 'POST' }),
          secret,
          enqueue,
        )
      ).status,
    ).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('Content-Length が無いストリームも、1 MiB を超えれば拒否する', async () => {
    const message = JSON.stringify(eligible());
    const limit = 1024 * 1024;
    const padding = ' '.repeat(limit - encoder.encode(message).byteLength + 1);
    const incoming = new Request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': await sign(message + padding),
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(message));
          controller.enqueue(encoder.encode(padding));
          controller.close();
        },
      }),
    });
    expect(incoming.headers.has('Content-Length')).toBe(false);
    const enqueue = queue();
    expect((await handlePreviewWebhook(incoming, secret, enqueue)).status).toBe(413);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['イベントが ping', 'ping', { zen: 'Keep it logically awesome.' }],
    ['イベント名が push', 'push', eligible()],
    ['PR が閉じた', 'pull_request', { ...eligible(), action: 'closed' }],
    ['配信元の ID が異なる', 'pull_request', { ...eligible(), repository: { ...repo, id: 42 } }],
    ['配信元の ID が文字列', 'pull_request', { ...eligible(), repository: { ...repo, id: '1425341812' } }],
    ['配信元の ID が無い', 'pull_request', { ...eligible(), repository: { full_name: repo.full_name } }],
    ['配信元が null', 'pull_request', { ...eligible(), repository: null }],
    [
      '配信元の名前は同じで ID が異なる',
      'pull_request',
      { ...eligible(), repository: { id: PREVIEW_REPOSITORY_ID + 1, full_name: repo.full_name } },
    ],
    [
      'head の ID が文字列',
      'pull_request',
      {
        ...eligible(),
        pull_request: {
          ...eligible().pull_request,
          head: { ...eligible().pull_request.head, repo: { ...repo, id: '1425341812' } },
        },
      },
    ],
    [
      'head の名前は同じで ID が異なる fork',
      'pull_request',
      {
        ...eligible(),
        pull_request: {
          ...eligible().pull_request,
          head: { ...eligible().pull_request.head, repo: { id: 42, full_name: repo.full_name } },
        },
      },
    ],
    [
      'head の repo が null（削除された fork）',
      'pull_request',
      {
        ...eligible(),
        pull_request: { ...eligible().pull_request, head: { ...eligible().pull_request.head, repo: null } },
      },
    ],
    [
      'base の ID が文字列',
      'pull_request',
      {
        ...eligible(),
        pull_request: {
          ...eligible().pull_request,
          base: { ...eligible().pull_request.base, repo: { ...repo, id: '1425341812' } },
        },
      },
    ],
    [
      'base の名前は同じで ID が異なる',
      'pull_request',
      {
        ...eligible(),
        pull_request: {
          ...eligible().pull_request,
          base: { ...eligible().pull_request.base, repo: { id: 42, full_name: repo.full_name } },
        },
      },
    ],
    [
      'head が fork',
      'pull_request',
      {
        ...eligible(),
        pull_request: {
          ...eligible().pull_request,
          head: { ...eligible().pull_request.head, repo: { ...repo, id: 42 } },
        },
      },
    ],
    [
      'base が異なるリポジトリ',
      'pull_request',
      {
        ...eligible(),
        pull_request: {
          ...eligible().pull_request,
          base: { ...eligible().pull_request.base, repo: { ...repo, id: 42 } },
        },
      },
    ],
    [
      'base が main 以外',
      'pull_request',
      { ...eligible(), pull_request: { ...eligible().pull_request, base: { ref: 'production', repo } } },
    ],
    [
      'PR 番号が無効',
      'pull_request',
      { ...eligible(), number: 0, pull_request: { ...eligible().pull_request, number: 0 } },
    ],
  ])('署名済みでも対象外なら起動しない: %s', async (_case, event, payload) => {
    const enqueue = queue();
    const response = await handlePreviewWebhook(await request(JSON.stringify(payload), event), secret, enqueue);
    expect(response.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(['main', 'production', 'feature/something', '0-task', '01379-task', '1379-', '1379-a\n'])(
    '無効な作業ブランチ %j では起動しない',
    async (branch) => {
      const payload = eligible();
      payload.pull_request.head.ref = branch;
      const enqueue = queue();
      expect((await handlePreviewWebhook(await request(JSON.stringify(payload)), secret, enqueue)).status).toBe(204);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(['abc', sha.toUpperCase(), sha + 'a', 'g'.repeat(40)])(
    '無効な commit SHA %j では起動しない',
    async (commit) => {
      const payload = eligible();
      payload.pull_request.head.sha = commit;
      const enqueue = queue();
      expect((await handlePreviewWebhook(await request(JSON.stringify(payload)), secret, enqueue)).status).toBe(204);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('キューへの登録に失敗したときは受け付けたと答えない', async () => {
    const enqueue = queue().mockRejectedValueOnce(new Error('queue unavailable'));
    const response = await handlePreviewWebhook(await request(JSON.stringify(eligible())), secret, enqueue);
    expect(response.status).toBe(503);
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
