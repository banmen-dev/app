import { DurableObject } from 'cloudflare:workers';
import { createPreviewApi } from './api.ts';
import { PreviewBuildQueue, type PreviewQueueState, type PreviewRecovery } from './queue.ts';
import { handlePreviewRecovery } from './recovery.ts';
import { handlePreviewWebhook, type PreviewRequest } from './webhook.ts';

interface PreviewTriggerEnv {
  GITHUB_WEBHOOK_SECRET?: string;
  PREVIEW_RECOVERY_SECRET?: string;
  CLOUDFLARE_BUILD_TRIGGER_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_PREVIEW_WORKER_TAG: string;
  CLOUDFLARE_PREVIEW_TRIGGER_ID: string;
  CLOUDFLARE_PREVIEW_BUILD_TOKEN_ID: string;
  PREVIEW_BUILDS: DurableObjectNamespace<PreviewBuildGate>;
}

// Issue 番号ごとに、D1 を作り直すビルドを一列に並べる。Webhook と運用者の復旧操作は下の入口で認証する。
export class PreviewBuildGate extends DurableObject<PreviewTriggerEnv> {
  private readonly queue = new PreviewBuildQueue({
    // 起動先などの検証は current で行う。不備があれば起動前の待ちを保つ。
    current: (request) => this.api().current(request),
    start: (request) => this.api().start(request),
    finished: (id) => this.api().finished(id),
    verifyRecovery: (id, request, attemptedAt) => this.api().verifyRecovery(id, request, attemptedAt),
    // 外部 HTTP の待ち時間は区間に含めず、同じ Issue の受付を止めない。
    withStorage: (operation) => this.ctx.blockConcurrencyWhile(operation),
    read: () => this.ctx.storage.get<PreviewQueueState>('queue'),
    write: (state) => this.ctx.storage.put('queue', state),
    schedule: async (delayMs) => {
      const at = Date.now() + delayMs;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || at < current) await this.ctx.storage.setAlarm(at);
    },
  });

  private api() {
    return createPreviewApi({
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      workerTag: this.env.CLOUDFLARE_PREVIEW_WORKER_TAG,
      triggerId: this.env.CLOUDFLARE_PREVIEW_TRIGGER_ID,
      buildTokenId: this.env.CLOUDFLARE_PREVIEW_BUILD_TOKEN_ID,
      token: this.env.CLOUDFLARE_BUILD_TRIGGER_TOKEN,
    });
  }

  enqueue(request: PreviewRequest): Promise<void> {
    return this.queue.enqueue(request);
  }

  status(): Promise<{ sha: string; attemptedAt: number } | null> {
    return this.queue.status();
  }

  recover(recovery: PreviewRecovery): Promise<boolean> {
    return this.queue.recover(recovery);
  }

  override alarm(): Promise<void> {
    return this.queue.run();
  }
}

export default {
  fetch(request: Request, env: PreviewTriggerEnv): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/operator/')) {
      return handlePreviewRecovery(request, env.PREVIEW_RECOVERY_SECRET, (issue) =>
        env.PREVIEW_BUILDS.getByName(issue),
      );
    }
    return handlePreviewWebhook(request, env.GITHUB_WEBHOOK_SECRET, (build) =>
      env.PREVIEW_BUILDS.getByName(build.issue).enqueue(build),
    );
  },
} satisfies ExportedHandler<PreviewTriggerEnv>;
