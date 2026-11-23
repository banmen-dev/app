import { expect, test, vi } from 'vitest';
import { createPreviewApi } from '../src/server/preview-trigger/api.ts';
import { PreviewBuildQueue, type PreviewQueueState } from '../src/server/preview-trigger/queue.ts';
import type { PreviewRequest } from '../src/server/preview-trigger/webhook.ts';

const accountId = 'a'.repeat(32);
const workerTag = 'b'.repeat(32);
const triggerId = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e';
const buildTokenId = '84c98460-ff84-4ab5-a1ab-d453d8f7df46';
const request: PreviewRequest = { issue: '42', pr: 81, branch: '42-preview', sha: 'c'.repeat(40) };
const repo = { id: 1425341812, full_name: 'banmen-dev/app' };
const parked = 'preview-builds-parked';
const commands = {
  build_command: 'APP_VERSION=$(git rev-parse HEAD) && export APP_VERSION && pnpm build',
  deploy_command: 'node scripts/deploy-preview.ts',
  root_directory: '/',
  build_token_uuid: buildTokenId,
};
const workerUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/workers/${workerTag}`;
const config = {
  git_repository: {
    provider_type: 'github',
    repo_id: String(repo.id),
    provider_account_name: 'banmen-dev',
    repo_name: 'app',
    branch: parked,
  },
  production_settings: commands,
  previews_enabled: false,
};
const trigger = {
  ...commands,
  trigger_uuid: triggerId,
  external_script_id: workerTag,
  branch_includes: [parked],
};

function previewApi(mismatch = {}, updatedAt = '2026-11-22T00:05:00Z') {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === 'https://api.github.com/repositories/1425341812/pulls/81') {
      return Response.json({
        number: request.pr,
        state: 'open',
        updated_at: updatedAt,
        head: { repo, ref: request.branch, sha: request.sha },
        base: { repo, ref: 'main' },
      });
    }
    if (url === workerUrl) return Response.json({ success: true, result: config });
    if (url === `${workerUrl}/triggers`) {
      return Response.json({ success: true, result: [{ ...trigger, ...mismatch }] });
    }
    return new Response(null, { status: 500 });
  });
  return createPreviewApi({ accountId, workerTag, triggerId, buildTokenId, token: 'TEST_TOKEN' }, fetcher);
}

test.each([
  { deploy_command: 'node scripts/other-preview.ts' },
  { build_command: 'pnpm build' },
  { root_directory: '/other' },
])('実際のトリガーの設定にも不一致があれば、Builds の起動対象にしない (%s)', async (mismatch) => {
  await expect(previewApi(mismatch).current(request)).rejects.toThrow(/trigger/i);
});

test('ラベル更新で GitHub の更新時刻が再開時刻より後になっても、署名済みの再開時刻を保持する', async () => {
  const reopened: PreviewRequest = { ...request, reopenedAt: '2026-11-22T00:04:00Z' };

  await expect(previewApi({}, '2026-11-22T00:05:00Z').current(reopened)).resolves.toEqual(reopened);
});

function queue() {
  let stored: PreviewQueueState | undefined;
  const start = vi.fn<(request: PreviewRequest) => Promise<string>>(async () => 'build');
  const gate = new PreviewBuildQueue({
    read: async () => stored,
    write: async (state) => {
      stored = structuredClone(state);
    },
    schedule: vi.fn(async () => {}),
    current: async (request) => request,
    start,
    finished: async () => true,
  });
  return {
    start,
    gate,
    async deliver(...deliveries: PreviewRequest[]) {
      for (const next of deliveries) {
        await gate.enqueue(next);
        await gate.run();
        await gate.run();
      }
    },
  };
}

test('同じコミットの PR を再開したときは1回だけ起動し、更新の再送では重ねない', async () => {
  const { start, deliver } = queue();
  const reopened: PreviewRequest = { ...request, reopenedAt: '2026-11-22T00:00:00Z' };

  await deliver(request, reopened, reopened, request);

  expect(start.mock.calls).toEqual([[request], [reopened]]);
});

test('より新しい再開を処理済みなら、古い再開イベントを再送しても同じ SHA を再ビルドしない', async () => {
  const { start, deliver } = queue();
  const older: PreviewRequest = { ...request, reopenedAt: '2026-11-22T00:01:00Z' };
  const newer: PreviewRequest = { ...request, reopenedAt: '2026-11-22T00:02:00Z' };

  await deliver(request, older, newer, older, newer);

  expect(start.mock.calls).toEqual([[request], [older], [newer]]);
});

test('待機中の再開は、同じ SHA の通常イベントが届いても保持する', async () => {
  const { start, gate } = queue();
  const reopened: PreviewRequest = { ...request, reopenedAt: '2026-11-22T00:03:00Z' };

  await gate.enqueue(request);
  await gate.run();
  await gate.enqueue(reopened);
  await gate.enqueue(request);
  await gate.run();

  expect(start.mock.calls).toEqual([[request], [reopened]]);
});
